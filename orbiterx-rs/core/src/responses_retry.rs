//! Shared retry and transport fallback decisions for Responses requests.

use std::time::Duration;

use crate::client::ModelClientSession;
use crate::session::session::Session;
use crate::session::turn_context::TurnContext;
use crate::util::backoff;
use http::StatusCode;
use orbiterx_protocol::error::OrbiterXErr;
use orbiterx_protocol::protocol::EventMsg;
use orbiterx_protocol::protocol::WarningEvent;
use tracing::warn;

/// True when the upstream reports that a chained `previous_response_id` can no
/// longer be resolved (for example a `store=false` prewarm response that was
/// never persisted). Recovery is deterministic: reset the websocket session so
/// the retry sends the full request instead of the same unresolvable chain.
fn is_previous_response_not_found(err: &OrbiterXErr) -> bool {
    let OrbiterXErr::UnexpectedStatus(err) = err else {
        return false;
    };
    if err.status != StatusCode::NOT_FOUND {
        return false;
    }
    let body = err.body.to_ascii_lowercase();
    body.contains("response") && body.contains("not found")
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum ResponsesStreamRequest {
    Sampling,
    RemoteCompactionV2,
}

/// Handles a retryable stream error and returns `Ok(())` when the caller should
/// retry the request loop.
pub(crate) async fn handle_retryable_response_stream_error(
    retries: &mut u64,
    max_retries: u64,
    err: OrbiterXErr,
    client_session: &mut ModelClientSession,
    sess: &Session,
    turn_context: &TurnContext,
    request: ResponsesStreamRequest,
) -> Result<(), OrbiterXErr> {
    if is_previous_response_not_found(&err) {
        // Retrying the same chained request would fail identically; drop the
        // websocket session so the next attempt resends the full request.
        client_session.reset_websocket_session();
    }

    if *retries >= max_retries
        && client_session.try_switch_fallback_transport(
            &turn_context.session_telemetry,
            &turn_context.model_info,
        )
    {
        sess.send_event(
            turn_context,
            EventMsg::Warning(WarningEvent {
                message: format!("Falling back from WebSockets to HTTPS transport. {err:#}"),
            }),
        )
        .await;
        *retries = 0;
        return Ok(());
    }

    if *retries < max_retries {
        *retries += 1;
        let retry_count = *retries;
        let delay = match &err {
            OrbiterXErr::Stream(_, requested_delay) => {
                requested_delay.unwrap_or_else(|| backoff(retry_count))
            }
            _ => backoff(retry_count),
        };
        log_retry(request, turn_context, &err, retry_count, max_retries, delay);

        // In release builds, hide the first websocket retry notification to reduce noisy
        // transient reconnect messages. In debug builds, keep full visibility for diagnosis.
        // A first-retry 404 for an unresolvable `previous_response_id` is a known
        // deterministic artifact that the session reset above already recovers from, so it
        // is never worth interrupting the user; later retries of the same error stay visible.
        let report_error = (retry_count > 1
            || cfg!(debug_assertions)
            || !sess.services.model_client.responses_websocket_enabled())
            && !(retry_count == 1 && is_previous_response_not_found(&err));
        if report_error {
            // Surface retry information to any UI/front-end so the user understands what is
            // happening instead of staring at a seemingly frozen screen.
            sess.notify_stream_error(
                turn_context,
                format!("Reconnecting... {retry_count}/{max_retries}"),
                err,
            )
            .await;
        }
        tokio::time::sleep(delay).await;
        return Ok(());
    }

    Err(err)
}

fn log_retry(
    request: ResponsesStreamRequest,
    turn_context: &TurnContext,
    err: &OrbiterXErr,
    retries: u64,
    max_retries: u64,
    delay: Duration,
) {
    match request {
        ResponsesStreamRequest::Sampling => {
            warn!(
                turn_id = %turn_context.sub_id,
                retries,
                max_retries,
                sampling_error = %err,
                "stream disconnected - retrying sampling request ({retries}/{max_retries} in {delay:?})...",
            );
        }
        ResponsesStreamRequest::RemoteCompactionV2 => {
            warn!(
                turn_id = %turn_context.sub_id,
                retries,
                max_retries,
                compact_error = %err,
                "remote compaction v2 stream failed; retrying request after delay"
            );
        }
    }
}

#[cfg(test)]
#[path = "responses_retry_tests.rs"]
mod tests;
