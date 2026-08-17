use crate::client_common::Prompt;
use crate::client_common::ResponseStream;
use crate::providers::ModelProvider;
use crate::providers::stream_openai_compatible;
use crate::providers::translate_history_to_openai;
use crate::providers::translate_tools_to_openai;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use futures::future::BoxFuture;
use futures::future::FutureExt;
use orbiterx_api::ResponseEvent;
use orbiterx_protocol::error::OrbiterXErr;
use orbiterx_protocol::error::Result;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Default)]
pub struct Direct;

impl Direct {
    pub fn new() -> Self {
        Self
    }
}

impl ModelProvider for Direct {
    fn stream_chat_completion(
        &self,
        prompt: &Prompt,
        model: &str,
        api_key: Option<&str>,
        base_url: Option<&str>,
    ) -> BoxFuture<'static, Result<ResponseStream>> {
        let model = model.to_string();
        let api_key = api_key.map(std::string::ToString::to_string);
        let base_url = base_url.map(std::string::ToString::to_string);
        let prompt = prompt.clone();

        async move {
            let is_anthropic = model.contains("claude")
                || base_url
                    .as_ref()
                    .is_some_and(|url| url.contains("anthropic.com"));

            if is_anthropic {
                let default_url = "https://api.anthropic.com/v1".to_string();
                let url_prefix = base_url.unwrap_or(default_url);
                let url = format!("{}/messages", url_prefix.trim_end_matches('/'));

                let client = reqwest::Client::new();
                let anthropic_messages =
                    crate::anthropic_translator::translate_history_to_anthropic(&prompt.input);
                let anthropic_tools =
                    crate::anthropic_translator::translate_tools_to_anthropic(&prompt.tools);

                let system_prompt = if prompt.base_instructions.text.is_empty() {
                    None
                } else {
                    Some(prompt.base_instructions.text.clone())
                };

                let mut body = json!({
                    "model": model,
                    "messages": anthropic_messages,
                    "stream": true,
                    "max_tokens": 4096,
                });
                if !anthropic_tools.is_empty() {
                    body.as_object_mut()
                        .unwrap()
                        .insert("tools".to_string(), json!(anthropic_tools));
                }
                if let Some(sys) = system_prompt {
                    body.as_object_mut()
                        .unwrap()
                        .insert("system".to_string(), json!(sys));
                }

                let mut req = client
                    .post(&url)
                    .json(&body)
                    .header("anthropic-version", "2023-06-01")
                    .header("content-type", "application/json");

                if let Some(key) = api_key {
                    req = req.header("x-api-key", key);
                } else if let Ok(env_key) = std::env::var("ANTHROPIC_API_KEY") {
                    req = req.header("x-api-key", env_key);
                }

                let response = req
                    .send()
                    .await
                    .map_err(|e| OrbiterXErr::Fatal(format!("Anthropic request failed: {e}")))?;

                if !response.status().is_success() {
                    let status = response.status();
                    let body_text = response.text().await.unwrap_or_default();
                    return Err(OrbiterXErr::Fatal(format!(
                        "Anthropic error status {status}: {body_text}"
                    )));
                }

                let (tx_event, rx_event) = mpsc::channel::<Result<ResponseEvent>>(1600);
                let consumer_dropped = CancellationToken::new();

                let stream = response
                    .bytes_stream()
                    .map(|item| item.map_err(std::io::Error::other));
                let mut event_stream = stream.eventsource();
                let model_slug = model.clone();

                tokio::spawn(async move {
                    let _ = tx_event.send(Ok(ResponseEvent::Created)).await;
                    let _ = tx_event
                        .send(Ok(ResponseEvent::ServerModel(model_slug)))
                        .await;
                    let _ = tx_event
                        .send(Ok(ResponseEvent::OutputItemAdded(
                            orbiterx_protocol::models::ResponseItem::Message {
                                id: Some(orbiterx_protocol::ResponseItemId::new("msg")),
                                role: "assistant".to_string(),
                                content: Vec::new(),
                                phase: None,
                                internal_chat_message_metadata_passthrough: None,
                            },
                        )))
                        .await;

                    #[derive(serde::Deserialize)]
                    struct MsgStart {
                        message: MsgStartInner,
                    }
                    #[derive(serde::Deserialize)]
                    struct MsgStartInner {
                        id: String,
                    }
                    #[derive(serde::Deserialize)]
                    #[serde(tag = "type", rename_all = "snake_case")]
                    enum BlockStart {
                        Text,
                        ToolUse { id: String },
                    }
                    #[derive(serde::Deserialize)]
                    struct BlockStartEvent {
                        index: usize,
                        content_block: BlockStart,
                    }
                    #[derive(serde::Deserialize)]
                    #[serde(tag = "type", rename_all = "snake_case")]
                    enum DeltaType {
                        TextDelta { text: String },
                        InputJsonDelta { partial_json: String },
                    }
                    #[derive(serde::Deserialize)]
                    struct DeltaEvent {
                        index: usize,
                        delta: DeltaType,
                    }

                    struct BlockState {
                        tool_id: String,
                    }

                    let mut blocks: Vec<Option<BlockState>> = Vec::new();
                    let mut response_id = String::new();

                    while let Some(event_res) = event_stream.next().await {
                        let event = match event_res {
                            Ok(e) => e,
                            Err(e) => {
                                let _ = tx_event
                                    .send(Err(OrbiterXErr::Fatal(format!("stream error: {e}"))))
                                    .await;
                                return;
                            }
                        };

                        if event.event == "message_start" {
                            if let Ok(msg_start) = serde_json::from_str::<MsgStart>(&event.data) {
                                response_id = msg_start.message.id;
                            }
                        } else if event.event == "content_block_start" {
                            if let Ok(block_start) =
                                serde_json::from_str::<BlockStartEvent>(&event.data)
                            {
                                let state = match block_start.content_block {
                                    BlockStart::Text => BlockState {
                                        tool_id: String::new(),
                                    },
                                    BlockStart::ToolUse { id, .. } => BlockState { tool_id: id },
                                };
                                if blocks.len() <= block_start.index {
                                    blocks.resize_with(block_start.index + 1, || None);
                                }
                                blocks[block_start.index] = Some(state);
                            }
                        } else if event.event == "content_block_delta"
                            && let Ok(delta_ev) = serde_json::from_str::<DeltaEvent>(&event.data)
                            && let Some(Some(state)) = blocks.get_mut(delta_ev.index)
                        {
                            match delta_ev.delta {
                                DeltaType::TextDelta { text } => {
                                    let _ = tx_event
                                        .send(Ok(ResponseEvent::OutputTextDelta(text)))
                                        .await;
                                }
                                DeltaType::InputJsonDelta { partial_json } => {
                                    let item_id = format!("item_{}", state.tool_id);
                                    let _ = tx_event
                                        .send(Ok(ResponseEvent::ToolCallInputDelta {
                                            item_id,
                                            call_id: Some(state.tool_id.clone()),
                                            delta: partial_json,
                                        }))
                                        .await;
                                }
                            }
                        }
                    }

                    let _ = tx_event
                        .send(Ok(ResponseEvent::Completed {
                            response_id,
                            token_usage: None,
                            end_turn: Some(true),
                        }))
                        .await;
                });

                Ok(ResponseStream {
                    rx_event,
                    consumer_dropped,
                })
            } else {
                // OpenAI or Gemini (OpenAI compatible)
                let default_url = "https://api.openai.com/v1".to_string();
                let url_prefix = base_url.unwrap_or(default_url);
                let url = format!("{}/chat/completions", url_prefix.trim_end_matches('/'));

                let client = reqwest::Client::new();
                let mut messages = Vec::new();
                if !prompt.base_instructions.text.is_empty() {
                    messages.push(json!({
                        "role": "system",
                        "content": prompt.base_instructions.text
                    }));
                }
                messages.extend(translate_history_to_openai(&prompt.input));

                let mut body = json!({
                    "model": model,
                    "messages": messages,
                    "stream": true,
                });

                let tools = translate_tools_to_openai(&prompt.tools);
                if !tools.is_empty() {
                    body.as_object_mut()
                        .unwrap()
                        .insert("tools".to_string(), json!(tools));
                    body.as_object_mut()
                        .unwrap()
                        .insert("tool_choice".to_string(), json!("auto"));
                }

                let mut req = client.post(&url).json(&body);

                if let Some(key) = api_key {
                    req = req.header("Authorization", format!("Bearer {key}"));
                } else if let Ok(env_key) = std::env::var("OPENAI_API_KEY") {
                    req = req.header("Authorization", format!("Bearer {env_key}"));
                }

                stream_openai_compatible(req, model).await
            }
        }
        .boxed()
    }
}
