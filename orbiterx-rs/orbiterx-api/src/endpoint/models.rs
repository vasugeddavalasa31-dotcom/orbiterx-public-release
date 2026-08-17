use crate::auth::SharedAuthProvider;
use crate::endpoint::session::EndpointSession;
use crate::error::ApiError;
use crate::provider::Provider;
use http::HeaderMap;
use http::Method;
use http::header::ETAG;
use orbiterx_client::HttpTransport;
use orbiterx_client::RequestTelemetry;
use orbiterx_protocol::openai_models::ModelInfo;
use orbiterx_protocol::openai_models::ModelsResponse;
use orbiterx_protocol::protocol::MultiAgentVersion;
use serde::Deserialize;
use std::sync::Arc;

/// OpenAI-standard `/models` list entry (e.g. DeepSeek returns
/// `{"object":"list","data":[{"id": "...", "owned_by": "..."}]}`).
#[derive(Deserialize)]
struct OpenAiModelListEntry {
    id: String,
    #[serde(default)]
    owned_by: Option<String>,
    #[serde(default)]
    multi_agent_version: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiModelListResponse {
    data: Vec<OpenAiModelListEntry>,
}

/// Maps an OpenAI-standard model list entry to a minimal [`ModelInfo`].
///
/// OpenAI-compatible providers (DeepSeek and friends) only report `id` and
/// `owned_by`, not OrbiterX's richer metadata. Deserializing through the
/// `#[serde(default)]` fields on [`ModelInfo`] keeps the model picker
/// populated with the provider's real models instead of falling back to the
/// bundled GPT catalog.
fn model_info_from_openai_entry(entry: OpenAiModelListEntry) -> Option<ModelInfo> {
    serde_json::from_value(serde_json::json!({
        "slug": entry.id,
        "display_name": entry.id,
        "description": entry.owned_by.map(|owned_by| format!("openai \u{00b7} {owned_by}")),
        "supported_reasoning_levels": [
            {"effort": "low", "description": "Low"},
            {"effort": "medium", "description": "Medium"},
            {"effort": "high", "description": "High"},
        ],
        "shell_type": "shell_command",
        "visibility": "list",
        "supported_in_api": true,
        "priority": 0,
        "base_instructions": "",
        "support_verbosity": false,
        "truncation_policy": {"mode": "bytes", "limit": 10000},
        "supports_parallel_tool_calls": true,
        "experimental_supported_tools": [],
        "multi_agent_version": entry.multi_agent_version,
    }))
    .ok()
}

pub struct ModelsClient<T: HttpTransport> {
    session: EndpointSession<T>,
}

impl<T: HttpTransport> ModelsClient<T> {
    pub fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self {
        Self {
            session: EndpointSession::new(transport, provider, auth),
        }
    }

    pub fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self {
        Self {
            session: self.session.with_request_telemetry(request),
        }
    }

    fn path() -> &'static str {
        "models"
    }

    fn append_client_version_query(req: &mut orbiterx_client::Request, client_version: &str) {
        let separator = if req.url.contains('?') { '&' } else { '?' };
        req.url = format!("{}{}client_version={client_version}", req.url, separator);
    }

    pub fn request_url(provider: &Provider, client_version: &str) -> String {
        let mut request = provider.build_request(Method::GET, Self::path());
        Self::append_client_version_query(&mut request, client_version);
        request.url
    }

    pub async fn list_models(
        &self,
        request_url: String,
        extra_headers: HeaderMap,
    ) -> Result<(Vec<ModelInfo>, Option<String>), ApiError> {
        let resp = self
            .session
            .execute_with(
                Method::GET,
                Self::path(),
                extra_headers,
                /*body*/ None,
                move |req| {
                    req.url.clone_from(&request_url);
                },
            )
            .await?;

        let header_etag = resp
            .headers
            .get(ETAG)
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string);

        let models = match serde_json::from_slice::<ModelsResponse>(&resp.body) {
            Ok(ModelsResponse { models }) => models,
            Err(_) => {
                // Some OpenAI-compatible providers (e.g. DeepSeek) serve the
                // standard `{"object":"list","data":[...]}` shape instead of
                // OrbiterX's `{"models":[...]}`. Map their entries to minimal
                // ModelInfos so the picker reflects the configured provider
                // instead of falling back to the bundled GPT catalog.
                let list =
                    serde_json::from_slice::<OpenAiModelListResponse>(&resp.body).map_err(|e| {
                        ApiError::Stream(format!(
                            "failed to decode models response: {e}; body: {}",
                            String::from_utf8_lossy(&resp.body)
                        ))
                    })?;
                list.data
                    .into_iter()
                    .filter_map(model_info_from_openai_entry)
                    .collect()
            }
        };

        Ok((models, header_etag))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::AuthProvider;
    use crate::provider::RetryConfig;
    use http::HeaderMap;
    use http::StatusCode;
    use orbiterx_client::Request;
    use orbiterx_client::Response;
    use orbiterx_client::StreamResponse;
    use orbiterx_client::TransportError;
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::time::Duration;

    #[derive(Clone)]
    struct CapturingTransport {
        last_request: Arc<Mutex<Option<Request>>>,
        body: Arc<ModelsResponse>,
        etag: Option<String>,
    }

    impl Default for CapturingTransport {
        fn default() -> Self {
            Self {
                last_request: Arc::new(Mutex::new(None)),
                body: Arc::new(ModelsResponse { models: Vec::new() }),
                etag: None,
            }
        }
    }

    impl HttpTransport for CapturingTransport {
        async fn execute(&self, req: Request) -> Result<Response, TransportError> {
            *self.last_request.lock().unwrap() = Some(req);
            let body = serde_json::to_vec(&*self.body).unwrap();
            let mut headers = HeaderMap::new();
            if let Some(etag) = &self.etag {
                headers.insert(ETAG, etag.parse().unwrap());
            }
            Ok(Response {
                status: StatusCode::OK,
                headers,
                body: body.into(),
            })
        }

        async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError> {
            Err(TransportError::Build("stream should not run".to_string()))
        }
    }

    #[derive(Clone, Default)]
    struct DummyAuth;

    impl AuthProvider for DummyAuth {
        fn add_auth_headers(&self, _headers: &mut HeaderMap) {}
    }

    fn provider(base_url: &str) -> Provider {
        Provider {
            name: "test".to_string(),
            base_url: base_url.to_string(),
            query_params: None,
            headers: HeaderMap::new(),
            retry: RetryConfig {
                max_attempts: 1,
                base_delay: Duration::from_millis(1),
                retry_429: false,
                retry_5xx: true,
                retry_transport: true,
            },
            stream_idle_timeout: Duration::from_secs(1),
        }
    }

    #[tokio::test]
    async fn appends_client_version_query() {
        let response = ModelsResponse { models: Vec::new() };

        let transport = CapturingTransport {
            last_request: Arc::new(Mutex::new(None)),
            body: Arc::new(response),
            etag: None,
        };

        let provider = provider("https://example.com/api/orbiterx");
        let request_url = ModelsClient::<CapturingTransport>::request_url(&provider, "0.99.0");
        let client = ModelsClient::new(transport.clone(), provider, Arc::new(DummyAuth));

        let (models, _) = client
            .list_models(request_url, HeaderMap::new())
            .await
            .expect("request should succeed");

        assert_eq!(models.len(), 0);

        let url = transport
            .last_request
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .url
            .clone();
        assert_eq!(
            url,
            "https://example.com/api/orbiterx/models?client_version=0.99.0"
        );
    }

    #[tokio::test]
    async fn parses_models_response() {
        let response = ModelsResponse {
            models: vec![
                serde_json::from_value(json!({
                    "slug": "gpt-test",
                    "display_name": "gpt-test",
                    "description": "desc",
                    "default_reasoning_level": "medium",
                    "supported_reasoning_levels": [{"effort": "low", "description": "low"}, {"effort": "medium", "description": "medium"}, {"effort": "high", "description": "high"}],
                    "shell_type": "shell_command",
                    "visibility": "list",
                    "minimal_client_version": [0, 99, 0],
                    "supported_in_api": true,
                    "priority": 1,
                    "upgrade": null,
                    "base_instructions": "base instructions",
                    "support_verbosity": false,
                    "default_verbosity": null,
                    "apply_patch_tool_type": null,
                    "truncation_policy": {"mode": "bytes", "limit": 10_000},
                    "supports_parallel_tool_calls": false,
                    "supports_image_detail_original": false,
                    "context_window": 272_000,
                    "experimental_supported_tools": [],
                }))
                .unwrap(),
            ],
        };

        let transport = CapturingTransport {
            last_request: Arc::new(Mutex::new(None)),
            body: Arc::new(response),
            etag: None,
        };

        let provider = provider("https://example.com/api/orbiterx");
        let request_url = ModelsClient::<CapturingTransport>::request_url(&provider, "0.99.0");
        let client = ModelsClient::new(transport, provider, Arc::new(DummyAuth));

        let (models, _) = client
            .list_models(request_url, HeaderMap::new())
            .await
            .expect("request should succeed");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].slug, "gpt-test");
        assert_eq!(models[0].supported_in_api, true);
        assert_eq!(models[0].priority, 1);
    }

    #[tokio::test]
    async fn list_models_includes_etag() {
        let response = ModelsResponse { models: Vec::new() };

        let transport = CapturingTransport {
            last_request: Arc::new(Mutex::new(None)),
            body: Arc::new(response),
            etag: Some("\"abc\"".to_string()),
        };

        let provider = provider("https://example.com/api/orbiterx");
        let request_url = ModelsClient::<CapturingTransport>::request_url(&provider, "0.1.0");
        let client = ModelsClient::new(transport, provider, Arc::new(DummyAuth));

        let (models, etag) = client
            .list_models(request_url, HeaderMap::new())
            .await
            .expect("request should succeed");

        assert_eq!(models.len(), 0);
        assert_eq!(etag, Some("\"abc\"".to_string()));
    }

    #[derive(Clone)]
    struct RawBodyTransport {
        body: Vec<u8>,
    }

    impl HttpTransport for RawBodyTransport {
        async fn execute(&self, _req: Request) -> Result<Response, TransportError> {
            Ok(Response {
                status: StatusCode::OK,
                headers: HeaderMap::new(),
                body: self.body.clone().into(),
            })
        }

        async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError> {
            Err(TransportError::Build("stream should not run".to_string()))
        }
    }

    #[tokio::test]
    async fn parses_openai_standard_models_list() {
        // DeepSeek and other OpenAI-compatible providers return
        // `{"object":"list","data":[{"id":...}]}` instead of OrbiterX's
        // `{"models":[...]}` — the picker must still show those models.
        let body = br#"{"object":"list","data":[
            {"id":"deepseek-v4-flash","object":"model","owned_by":"deepseek","multi_agent_version":"v2"},
            {"id":"deepseek-v4-pro","object":"model","owned_by":"deepseek","multi_agent_version":"v2"}
        ]}"#;
        let transport = RawBodyTransport {
            body: body.to_vec(),
        };

        let provider = provider("https://api.deepseek.com/v1");
        let request_url = ModelsClient::<RawBodyTransport>::request_url(&provider, "0.1.0");
        let client = ModelsClient::new(transport, provider, Arc::new(DummyAuth));

        let (models, _) = client
            .list_models(request_url, HeaderMap::new())
            .await
            .expect("request should succeed");

        let slugs: Vec<&str> = models.iter().map(|model| model.slug.as_str()).collect();
        assert_eq!(slugs, vec!["deepseek-v4-flash", "deepseek-v4-pro"]);
        assert!(models.iter().all(|model| model.supported_in_api));
        assert!(models.iter().all(|model| model.display_name == model.slug));
        // The gateway advertises V2 multi-agent support; it must survive the
        // minimal-entry mapping or the app hides the sub-agent spawn tools.
        assert!(
            models
                .iter()
                .all(|model| model.multi_agent_version == Some(MultiAgentVersion::V2))
        );
    }
}
