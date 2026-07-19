const PERSONAL_ACCESS_TOKEN_PREFIX: &str = "at-";

pub(super) enum OrbiterXAccessToken<'a> {
    PersonalAccessToken(&'a str),
    AgentIdentityJwt(&'a str),
}

pub(super) fn classify_orbiterx_access_token(access_token: &str) -> OrbiterXAccessToken<'_> {
    if access_token.starts_with(PERSONAL_ACCESS_TOKEN_PREFIX) {
        OrbiterXAccessToken::PersonalAccessToken(access_token)
    } else {
        OrbiterXAccessToken::AgentIdentityJwt(access_token)
    }
}

#[cfg(test)]
#[path = "access_token_tests.rs"]
mod tests;
