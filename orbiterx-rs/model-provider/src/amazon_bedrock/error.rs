use http::StatusCode;
use orbiterx_api::ApiError;
use orbiterx_protocol::error::OrbiterXErr;

pub(super) const BEDROCK_EXPIRED_SIGNATURE_MESSAGE: &str = concat!(
    "Amazon Bedrock rejected the request because its AWS signature has expired. ",
    "Refresh your AWS credentials and retry. If `AWS_BEARER_TOKEN_BEDROCK` is set, ",
    "update or unset it, then restart OrbiterX",
);

pub(super) fn map_api_error(error: ApiError) -> OrbiterXErr {
    let mut error = orbiterx_api::map_api_error(error);
    if let OrbiterXErr::UnexpectedStatus(response) = &mut error
        && response.status == StatusCode::UNAUTHORIZED
        && response.body.contains("Signature expired:")
    {
        response.user_message = Some(BEDROCK_EXPIRED_SIGNATURE_MESSAGE.to_string());
    }
    error
}
