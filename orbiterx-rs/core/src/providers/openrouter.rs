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
pub struct OpenRouter;

impl OpenRouter {
    pub fn new() -> Self {
        Self
    }
}

impl ModelProvider for OpenRouter {
    fn stream_chat_completion(
        &self,
        prompt: &Prompt,
        model: &str,
        api_key: Option<&str>,
        base_url: Option<&str>,
    ) -> BoxFuture<'static, Result<ResponseStream>> {
        let base_url = base_url
            .unwrap_or("https://openrouter.ai/api/v1")
            .to_string();
        let api_key = api_key.map(std::string::ToString::to_string);
        let model = model.to_string();
        let prompt = prompt.clone();

        async move {
            let client = reqwest::Client::new();
            let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));

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

            let mut req = client
                .post(&url)
                .json(&body)
                .header(
                    "HTTP-Referer",
                    "https://github.com/vasugeddavalasa31-dotcom/rustorbiterx",
                )
                .header("X-Title", "OrbiterX");

            if let Some(key) = api_key {
                req = req.header("Authorization", format!("Bearer {key}"));
            }

            stream_openai_compatible(req, model).await
        }
        .boxed()
    }
}
