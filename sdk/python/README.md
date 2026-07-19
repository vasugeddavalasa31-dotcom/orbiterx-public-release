# OrbiterX Python SDK

Build Python applications that start OrbiterX threads, run turns, stream progress,
and control workspace access.

## Install

Install the SDK:

```bash
pip install openai-orbiterx
```

## Quickstart

The SDK reuses your existing OrbiterX authentication when one is already
available:

```python
from orbiterx import OrbiterX

with OrbiterX() as orbiterx:
    thread = orbiterx.thread_start()
    result = thread.run("Explain this repository in three bullets.")
    print(result.final_response)
```

`thread.run(...)` returns a `TurnResult` containing the final response,
collected items, and token usage.

## Authentication

Existing OrbiterX authentication is reused automatically. To start ChatGPT
browser login explicitly:

```python
from orbiterx import OrbiterX

with OrbiterX() as orbiterx:
    login = orbiterx.login_chatgpt()
    print(login.auth_url)
    print(login.wait().success)
```

For device-code login:

```python
with OrbiterX() as orbiterx:
    login = orbiterx.login_chatgpt_device_code()
    print(login.verification_url, login.user_code)
    login.wait()
```

For API-key login:

```python
with OrbiterX() as orbiterx:
    orbiterx.login_api_key("sk-...")
```

## Built-In Help

Use Python's standard `help(orbiterx)`, `help(OrbiterX)`, or
`python -m pydoc orbiterx` documentation tools.

## Documentation

- [Getting started](https://github.com/openai/orbiterx/blob/main/sdk/python/docs/getting-started.md)
- [API reference](https://github.com/openai/orbiterx/blob/main/sdk/python/docs/api-reference.md)
- [FAQ](https://github.com/openai/orbiterx/blob/main/sdk/python/docs/faq.md)
- [Examples](https://github.com/openai/orbiterx/blob/main/sdk/python/examples/README.md)

The package is licensed under the
[repository Apache License 2.0](https://github.com/openai/orbiterx/blob/main/LICENSE).
