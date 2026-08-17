pub mod direct;
pub mod ollama;
pub mod openrouter;
pub mod validation;

use crate::client_common::Prompt;
use crate::client_common::ResponseStream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use futures::future::BoxFuture;
use orbiterx_api::ResponseEvent;
use orbiterx_protocol::error::OrbiterXErr;
use orbiterx_protocol::error::Result;
use orbiterx_protocol::models::ContentItem;
use orbiterx_protocol::models::ResponseItem;
use orbiterx_tools::ToolSpec;
use serde_json::Value as JsonValue;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub trait ModelProvider: std::fmt::Debug + Send + Sync {
    fn stream_chat_completion(
        &self,
        prompt: &Prompt,
        model: &str,
        api_key: Option<&str>,
        base_url: Option<&str>,
    ) -> BoxFuture<'static, Result<ResponseStream>>;
}

pub fn get_provider(provider_type: &str) -> Box<dyn ModelProvider> {
    match provider_type.to_lowercase().as_str() {
        "openrouter" => Box::new(openrouter::OpenRouter::new()),
        "ollama" => Box::new(ollama::Ollama::new()),
        "direct" => Box::new(direct::Direct::new()),
        _ => Box::new(direct::Direct::new()),
    }
}

pub fn translate_history_to_openai(items: &[ResponseItem]) -> Vec<JsonValue> {
    let mut messages = Vec::new();
    for item in items {
        match item {
            ResponseItem::Message { role, content, .. } => {
                let mut parts = Vec::new();
                for content_item in content {
                    match content_item {
                        ContentItem::InputText { text } | ContentItem::OutputText { text } => {
                            parts.push(json!({
                                "type": "text",
                                "text": text
                            }));
                        }
                        ContentItem::InputImage { image_url, .. } => {
                            parts.push(json!({
                                "type": "image_url",
                                "image_url": {
                                    "url": image_url
                                }
                            }));
                        }
                        _ => {}
                    }
                }
                messages.push(json!({
                    "role": role,
                    "content": parts
                }));
            }
            ResponseItem::FunctionCall {
                call_id,
                name,
                arguments,
                ..
            } => {
                messages.push(json!({
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments
                        }
                    }]
                }));
            }
            ResponseItem::FunctionCallOutput {
                call_id, output, ..
            } => {
                let content = output.body.to_text().unwrap_or_default();
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content
                }));
            }
            ResponseItem::CustomToolCall {
                call_id,
                name,
                input,
                ..
            } => {
                messages.push(json!({
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": call_id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": input
                        }
                    }]
                }));
            }
            ResponseItem::CustomToolCallOutput {
                call_id, output, ..
            } => {
                let content = output.body.to_text().unwrap_or_default();
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content
                }));
            }
            _ => {}
        }
    }
    messages
}

pub fn translate_tools_to_openai(tools: &[ToolSpec]) -> Vec<JsonValue> {
    let mut result = Vec::new();
    for spec in tools {
        match spec {
            ToolSpec::Function(tool) => {
                result.push(json!({
                    "type": "function",
                    "function": {
                        "name": tool.name.clone(),
                        "description": tool.description.clone(),
                        "parameters": tool.parameters.clone()
                    }
                }));
            }
            ToolSpec::Namespace(ns) => {
                for ns_tool in &ns.tools {
                    match ns_tool {
                        orbiterx_tools::ResponsesApiNamespaceTool::Function(tool) => {
                            result.push(json!({
                                "type": "function",
                                "function": {
                                    "name": format!("{}__{}", ns.name, tool.name),
                                    "description": tool.description.clone(),
                                    "parameters": tool.parameters.clone()
                                }
                            }));
                        }
                    }
                }
            }
            ToolSpec::Freeform(tool) => {
                result.push(json!({
                    "type": "function",
                    "function": {
                        "name": tool.name.clone(),
                        "description": tool.description.clone(),
                        "parameters": json!({ "type": "object" })
                    }
                }));
            }
            _ => {}
        }
    }
    result
}

pub async fn stream_openai_compatible(
    req_builder: reqwest::RequestBuilder,
    model: String,
) -> Result<ResponseStream> {
    let pid = std::process::id();
    let debug_path = format!("/Users/vasu/orbiterx_debug_{pid}.log");
    let _ = std::fs::write(
        &debug_path,
        format!("stream_openai_compatible called for model: {model}\n"),
    );
    let response = req_builder
        .send()
        .await
        .map_err(|e| OrbiterXErr::Fatal(format!("Request failed: {e}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body_text = response.text().await.unwrap_or_default();
        let _ = std::fs::write(
            &debug_path,
            format!("Request failed with status {status}: {body_text}\n"),
        );
        return Err(OrbiterXErr::Fatal(format!(
            "Error status {status}: {body_text}"
        )));
    }
    let _ = std::fs::write(&debug_path, "Request succeeded, starting SSE stream\n");

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
            .send(Ok(ResponseEvent::OutputItemAdded(ResponseItem::Message {
                id: Some(orbiterx_protocol::ResponseItemId::new("msg")),
                role: "assistant".to_string(),
                content: Vec::new(),
                phase: None,
                internal_chat_message_metadata_passthrough: None,
            })))
            .await;

        #[derive(serde::Deserialize)]
        struct Delta {
            content: Option<String>,
            tool_calls: Option<Vec<ToolCallDelta>>,
        }
        #[derive(serde::Deserialize)]
        struct ToolCallDelta {
            index: usize,
            id: Option<String>,
            function: Option<FunctionDelta>,
        }
        #[derive(serde::Deserialize)]
        struct FunctionDelta {
            name: Option<String>,
            arguments: Option<String>,
        }
        #[derive(serde::Deserialize)]
        struct Choice {
            delta: Delta,
        }
        #[derive(serde::Deserialize)]
        struct Chunk {
            id: Option<String>,
            choices: Vec<Choice>,
        }

        let mut response_id = String::new();
        let mut tool_ids = std::collections::HashMap::<usize, String>::new();
        let mut tool_names = std::collections::HashMap::<usize, String>::new();
        let mut tool_args = std::collections::HashMap::<usize, String>::new();
        let mut emitted_tool_items = std::collections::HashSet::<usize>::new();

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

            if event.data == "[DONE]" {
                break;
            }

            if let Ok(chunk) = serde_json::from_str::<Chunk>(&event.data) {
                if let Some(id) = chunk.id {
                    response_id = id;
                }
                for choice in chunk.choices {
                    if let Some(content) = choice.delta.content
                        && !content.is_empty()
                    {
                        let _ = tx_event
                            .send(Ok(ResponseEvent::OutputTextDelta(content)))
                            .await;
                    }
                    if let Some(tool_calls) = choice.delta.tool_calls {
                        for tc in tool_calls {
                            let index = tc.index;
                            if let Some(id) = tc.id {
                                tool_ids.insert(index, id);
                            }
                            if let Some(func) = &tc.function {
                                if let Some(name) = &func.name {
                                    tool_names.insert(index, name.clone());
                                }
                                if let Some(args) = &func.arguments {
                                    tool_args.entry(index).or_default().push_str(args);
                                }
                            }
                            if !emitted_tool_items.contains(&index)
                                && let (Some(id), Some(name)) =
                                    (tool_ids.get(&index), tool_names.get(&index))
                            {
                                emitted_tool_items.insert(index);
                                let item_id = format!("call_{id}");
                                let _ = tx_event
                                    .send(Ok(ResponseEvent::OutputItemAdded(
                                        ResponseItem::FunctionCall {
                                            call_id: id.clone(),
                                            name: name.clone(),
                                            namespace: None,
                                            arguments: String::new(),
                                            id: Some(orbiterx_protocol::ResponseItemId::new(
                                                &item_id,
                                            )),
                                            internal_chat_message_metadata_passthrough: None,
                                        },
                                    )))
                                    .await;
                            }
                            let id_str = tool_ids.get(&index).cloned();
                            if let Some(func) = tc.function
                                && let Some(args) = func.arguments
                            {
                                let item_id = format!("call_{}", id_str.as_deref().unwrap_or(""));
                                let _ = tx_event
                                    .send(Ok(ResponseEvent::ToolCallInputDelta {
                                        item_id,
                                        call_id: id_str,
                                        delta: args,
                                    }))
                                    .await;
                            }
                        }
                    }
                }
            }
        }

        for (index, id) in &tool_ids {
            if emitted_tool_items.contains(index)
                && let Some(name) = tool_names.get(index)
            {
                let item_id = format!("call_{id}");
                let arguments = tool_args.remove(index).unwrap_or_default();
                let _ = tx_event
                    .send(Ok(ResponseEvent::OutputItemDone(
                        ResponseItem::FunctionCall {
                            call_id: id.clone(),
                            name: name.clone(),
                            namespace: None,
                            arguments,
                            id: Some(orbiterx_protocol::ResponseItemId::new(&item_id)),
                            internal_chat_message_metadata_passthrough: None,
                        },
                    )))
                    .await;
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
}
