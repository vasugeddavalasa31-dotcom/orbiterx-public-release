use super::*;

#[test]
fn classifies_personal_access_tokens_by_prefix() {
    assert!(matches!(
        classify_orbiterx_access_token("at-example"),
        OrbiterXAccessToken::PersonalAccessToken("at-example")
    ));
    assert!(matches!(
        classify_orbiterx_access_token("header.payload.signature"),
        OrbiterXAccessToken::AgentIdentityJwt("header.payload.signature")
    ));
}
