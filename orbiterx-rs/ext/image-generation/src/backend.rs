use http::HeaderMap;
use orbiterx_api::ImageEditRequest;
use orbiterx_api::ImageGenerationRequest;
use orbiterx_api::ImageResponse;
use orbiterx_api::ImagesClient;
use orbiterx_api::ReqwestTransport;
use orbiterx_login::default_client::add_originator_header;
use orbiterx_login::default_client::build_reqwest_client;
use orbiterx_model_provider::SharedModelProvider;

#[derive(Clone)]
pub(crate) struct OrbiterXImagesBackend {
    provider: SharedModelProvider,
    originator: Option<String>,
}

impl OrbiterXImagesBackend {
    /// Creates a backend that sends image requests through the active model provider.
    pub(crate) fn new(provider: SharedModelProvider, originator: Option<String>) -> Self {
        Self {
            provider,
            originator,
        }
    }

    /// Resolves the provider and auth required for the current image API request.
    async fn client(&self) -> Result<ImagesClient<ReqwestTransport>, String> {
        let provider = self
            .provider
            .api_provider()
            .await
            .map_err(|err| err.to_string())?;
        let auth = self
            .provider
            .api_auth()
            .await
            .map_err(|err| err.to_string())?;
        Ok(ImagesClient::new(
            ReqwestTransport::new(build_reqwest_client()),
            provider,
            auth,
        ))
    }

    /// Sends a standalone image generation request through the configured Images client.
    pub(crate) async fn generate(
        &self,
        request: ImageGenerationRequest,
    ) -> Result<ImageResponse, String> {
        self.client()
            .await?
            .generate(&request, image_request_headers(self.originator.as_deref()))
            .await
            .map_err(|err| err.to_string())
    }

    /// Sends a standalone image edit request through the configured Images client.
    pub(crate) async fn edit(&self, request: ImageEditRequest) -> Result<ImageResponse, String> {
        self.client()
            .await?
            .edit(&request, image_request_headers(self.originator.as_deref()))
            .await
            .map_err(|err| err.to_string())
    }
}

fn image_request_headers(originator: Option<&str>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(originator) = originator {
        add_originator_header(&mut headers, originator);
    }
    headers
}
