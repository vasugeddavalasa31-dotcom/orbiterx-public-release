use crate::client_common::Prompt;
use crate::client_common::ResponseStream;
use crate::providers::ModelProvider;
use crate::providers::stream_openai_compatible;
use crate::providers::translate_history_to_openai;
use crate::providers::translate_tools_to_openai;
use futures::future::BoxFuture;
use futures::future::FutureExt;
use orbiterx_protocol::error::Result;
use serde_json::json;

#[derive(Debug, Clone, Default)]
pub struct Ollama;

impl Ollama {
    pub fn new() -> Self {
        Self
    }
}

impl ModelProvider for Ollama {
    fn stream_chat_completion(
        &self,
        prompt: &Prompt,
        model: &str,
        api_key: Option<&str>,
        base_url: Option<&str>,
    ) -> BoxFuture<'static, Result<ResponseStream>> {
        let base = base_url
            .unwrap_or("http://localhost:11434")
            .trim_end_matches('/');
        let url_prefix = if base.ends_with("/v1") {
            base.to_string()
        } else {
            format!("{base}/v1")
        };
        let api_key = api_key.map(std::string::ToString::to_string);
        let model = model.to_string();
        let prompt = prompt.clone();

        async move {
            let client = reqwest::Client::new();
            let url = format!("{url_prefix}/chat/completions");

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
            }

            stream_openai_compatible(req, model).await
        }
        .boxed()
    }
}
