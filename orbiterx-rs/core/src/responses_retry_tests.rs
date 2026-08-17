use super::ResponsesStreamRequest;
use super::is_previous_response_not_found;
use super::log_retry;
use crate::session::tests::make_session_and_context;
use http::StatusCode;
use orbiterx_protocol::error::OrbiterXErr;
use orbiterx_protocol::error::UnexpectedResponseError;
use std::time::Duration;
use tracing_test::internal::MockWriter;

fn unexpected_status(status: StatusCode, body: &str) -> OrbiterXErr {
    OrbiterXErr::UnexpectedStatus(UnexpectedResponseError {
        status,
        body: body.to_string(),
        user_message: None,
        url: None,
        cf_ray: None,
        request_id: None,
        identity_authorization_error: None,
        identity_error_code: None,
    })
}

#[test]
fn previous_response_not_found_detection() {
    let missing_response = unexpected_status(
        StatusCode::NOT_FOUND,
        r#"{"type":"error","status":404,"error":{"code":"previous_response_not_found","message":"Response 'resp_1' not found. Use 'client.responses.list()' to list available Responses."}}"#,
    );
    assert!(is_previous_response_not_found(&missing_response));

    let missing_model = unexpected_status(
        StatusCode::NOT_FOUND,
        r#"{"error":{"message":"Model 'deepseek-v4-flash' not found or disabled"}}"#,
    );
    assert!(!is_previous_response_not_found(&missing_model));

    let server_error = unexpected_status(
        StatusCode::INTERNAL_SERVER_ERROR,
        "Response 'resp_1' not found",
    );
    assert!(!is_previous_response_not_found(&server_error));

    assert!(!is_previous_response_not_found(&OrbiterXErr::Stream(
        "stream disconnected before completion".to_string(),
        None,
    )));
}

#[tokio::test]
async fn sampling_retry_logs_stream_error_context() {
    let (_session, turn_context) = make_session_and_context().await;
    let buffer: &'static std::sync::Mutex<Vec<u8>> =
        Box::leak(Box::new(std::sync::Mutex::new(Vec::new())));
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_max_level(tracing::Level::WARN)
        .with_writer(MockWriter::new(buffer))
        .finish();
    let _subscriber_guard = tracing::subscriber::set_default(subscriber);

    log_retry(
        ResponsesStreamRequest::Sampling,
        &turn_context,
        &OrbiterXErr::Stream(
            "websocket closed by server before response.completed".to_string(),
            None,
        ),
        /*retries*/ 2,
        /*max_retries*/ 5,
        Duration::from_secs(1),
    );

    let logs = String::from_utf8(
        buffer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone(),
    )
    .expect("retry log should be valid utf-8");
    assert!(logs.contains("stream disconnected - retrying sampling request"));
    assert!(logs.contains(&format!("turn_id={}", turn_context.sub_id)));
    assert!(logs.contains("retries=2"));
    assert!(logs.contains("max_retries=5"));
    assert!(logs.contains(
        "sampling_error=stream disconnected before completion: websocket closed by server before response.completed"
    ));
}
