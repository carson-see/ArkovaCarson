from __future__ import annotations

import asyncio
import json
import traceback

import httpx
import pytest

from arkova import Arkova, ArkovaError, AsyncArkova

AGENT_ID = "11111111-1111-4111-8111-111111111111"
AGENT = {
    "id": AGENT_ID, "name": "Verifier", "description": None, "agent_type": "custom",
    "status": "active", "allowed_scopes": ["verify"], "framework": None,
    "version": None, "callback_url": None, "metadata": {},
}
ADMISSION_AGENT = {"id": AGENT_ID, "name": "Verifier", "agent_type": "llm_agent", "status": "active",
    "allowed_scopes": ["verify"], "created_at": "2026-09-26T00:00:00Z"}
RECEIPT = {
    "passport_id": AGENT_ID, "status": "verified", "issued_at": "2026-09-26T00:00:00Z",
    "expires_at": "2026-09-27T00:00:00Z", "key_id": "0123456789abcdef",
    "receipt_signature": "sentinel-signature", "receipt_algorithm": "EdDSA",
    "receipt_payload": "{}", "extension": "preserved",
}


def test_sync_agent_lifecycle_routes_auth_and_no_write_retry() -> None:
    seen: list[httpx.Request] = []
    responses = [
        (201, AGENT), (200, {"agents": [AGENT]}), (200, {**AGENT, "api_keys": []}),
        (200, {**AGENT, "name": "Updated"}), (200, {"status": "revoked", "agent_id": AGENT_ID}),
        (201, {"key": "ak_once", "key_id": "key-1", "key_prefix": "ak_once", "agent_id": AGENT_ID,
               "agent_name": "Verifier", "scopes": ["verify"], "created_at": "2026-09-26T00:00:00Z", "warning": "once"}),
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        status, body = responses.pop(0)
        return httpx.Response(status, json=body)

    client = Arkova(api_key="ak_caller", retries=2, transport=httpx.MockTransport(handler))
    assert client.register_agent(name="Verifier").agent_type == "custom"
    assert len(client.list_agents().agents) == 1
    assert client.get_agent(AGENT_ID).api_keys == []
    assert client.update_agent(AGENT_ID, name="Updated").name == "Updated"
    assert client.revoke_agent(AGENT_ID).agent_id == AGENT_ID
    assert client.create_agent_key(AGENT_ID).key == "ak_once"
    assert all(r.headers["authorization"] == "Bearer ak_caller" and "x-api-key" not in r.headers for r in seen)
    assert [(r.method, r.url.path) for r in seen] == [
        ("POST", "/v1/agents"), ("GET", "/v1/agents"),
        ("GET", f"/v1/agents/{AGENT_ID}"), ("PATCH", f"/v1/agents/{AGENT_ID}"),
        ("DELETE", f"/v1/agents/{AGENT_ID}"), ("POST", f"/v1/agents/{AGENT_ID}/key"),
    ]


def test_async_admission_preserves_receipt_and_nested_error() -> None:
    asyncio.run(_async_admission_preserves_receipt_and_nested_error())


async def _async_admission_preserves_receipt_and_nested_error() -> None:
    seen: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(201, json={"agent": ADMISSION_AGENT, "binding": {"issuer": "computeid", "passport_id": AGENT_ID,
                "bound_at": "2026-09-26T00:00:00Z", "receipt_expires_at": "2026-09-27T00:00:00Z"},
                "key": "ak_admitted", "key_id": "key-2", "key_prefix": "ak_admit", "scopes": ["verify"], "warning": "once"})
        return httpx.Response(401, json={"error": {"code": "receipt_invalid", "reason": "expired"}})

    client = AsyncArkova(api_key="ak_caller", retries=2, transport=httpx.MockTransport(handler))
    result = await client.admit_computeid_agent(passport_id=AGENT_ID, verification_receipt=RECEIPT)
    assert result.key == "ak_admitted"
    assert json.loads(seen[0].content)["verification_receipt"] == RECEIPT
    with pytest.raises(ArkovaError) as raised:
        await client.admit_computeid_agent(passport_id=AGENT_ID, verification_receipt=RECEIPT)
    assert (raised.value.status_code, raised.value.code, raised.value.details) == (
        401, "receipt_invalid", {"code": "receipt_invalid", "reason": "expired"},
    )
    assert len(seen) == 2
    await client.aclose()


@pytest.mark.parametrize("operation", ["register", "update", "revoke", "create_key", "admit"])
def test_each_sync_mutation_does_not_retry_or_leak_nested_body(operation: str) -> None:
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, json={"error": {"code": "admission_failed", "secret": "do-not-leak"}})

    client = Arkova(api_key="ak_caller", retries=3, transport=httpx.MockTransport(handler))
    with pytest.raises(ArkovaError) as raised:
        {
            "register": lambda: client.register_agent(name="Verifier"),
            "update": lambda: client.update_agent(AGENT_ID, name="Updated"),
            "revoke": lambda: client.revoke_agent(AGENT_ID),
            "create_key": lambda: client.create_agent_key(AGENT_ID),
            "admit": lambda: client.admit_computeid_agent(passport_id=AGENT_ID, verification_receipt=RECEIPT),
        }[operation]()
    assert calls == 1
    assert raised.value.code == "admission_failed"
    assert "do-not-leak" not in str(raised.value)
    assert "do-not-leak" not in json.dumps(raised.value.details)


def test_sync_and_async_expose_all_seven_operations() -> None:
    names = {"register_agent", "list_agents", "get_agent", "update_agent", "revoke_agent", "create_agent_key", "admit_computeid_agent"}
    assert all(callable(getattr(Arkova, name, None)) for name in names)
    assert all(callable(getattr(AsyncArkova, name, None)) for name in names)


@pytest.mark.parametrize("operation", ["register", "update", "revoke", "create_key", "admit"])
def test_each_async_mutation_does_not_retry(operation: str) -> None:
    asyncio.run(_assert_async_mutation_does_not_retry(operation))


async def _assert_async_mutation_does_not_retry(operation: str) -> None:
    calls = 0

    async def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(503, json={"error": {"code": "temporary"}})

    client = AsyncArkova(api_key="ak", retries=3, transport=httpx.MockTransport(handler))
    calls_by_name = {
        "register": lambda: client.register_agent(name="Verifier"),
        "update": lambda: client.update_agent(AGENT_ID, name="Updated"),
        "revoke": lambda: client.revoke_agent(AGENT_ID),
        "create_key": lambda: client.create_agent_key(AGENT_ID),
        "admit": lambda: client.admit_computeid_agent(passport_id=AGENT_ID, verification_receipt=RECEIPT),
    }
    with pytest.raises(ArkovaError):
        await calls_by_name[operation]()
    assert calls == 1
    await client.aclose()


def test_detail_drops_unexpected_raw_key_material() -> None:
    body = {**AGENT, "api_keys": [{"id": "key-1", "name": "key", "key_prefix": "ak_pref", "key": "ak_raw",
        "key_hash": "hash", "scopes": ["verify"], "is_active": True, "created_at": "2026-09-26T00:00:00Z"}]}
    client = Arkova(api_key="ak", transport=httpx.MockTransport(lambda _r: httpx.Response(200, json=body)))
    dumped = client.get_agent(AGENT_ID).model_dump()
    assert "ak_raw" not in json.dumps(dumped)
    assert "key_hash" not in json.dumps(dumped)


@pytest.mark.parametrize("async_client", [False, True])
def test_malformed_one_time_response_never_leaks_key_or_receipt_in_traceback(async_client: bool) -> None:
    secret = "ak_raw_sentinel"
    signed = "signed-receipt-sentinel"
    transport = httpx.MockTransport(lambda _r: httpx.Response(201, json={"key": secret, "receipt_signature": signed}))

    async def invoke_async() -> None:
        client = AsyncArkova(api_key="ak", transport=transport)
        try:
            await client.admit_computeid_agent(passport_id=AGENT_ID, verification_receipt=RECEIPT)
        finally:
            await client.aclose()

    try:
        if async_client:
            asyncio.run(invoke_async())
        else:
            Arkova(api_key="ak", transport=transport).create_agent_key(AGENT_ID)
    except ArkovaError as exc:
        rendered = "".join(traceback.format_exception(exc)) + repr(exc.__cause__) + repr(exc.__context__)
        assert secret not in rendered and signed not in rendered
        assert exc.code == "unexpected_response"
    else:
        pytest.fail("malformed one-time response was accepted")


def test_invalid_inputs_make_no_request() -> None:
    calls = 0
    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)
    client = Arkova(api_key="ak", transport=httpx.MockTransport(handler))
    with pytest.raises(ArkovaError): client.register_agent(name="x", callback_url="http://unsafe.test")
    with pytest.raises(ArkovaError): client.register_agent(name="x", callback_url="https://")
    with pytest.raises(ArkovaError): client.update_agent(AGENT_ID, status="revoked")
    with pytest.raises(ArkovaError): client.admit_computeid_agent(passport_id=AGENT_ID, verification_receipt={})
    assert calls == 0


def test_null_agent_metadata_does_not_hide_list_sync_or_async() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        row = {**AGENT, "metadata": None}
        return httpx.Response(200, json={"agents": [row, AGENT]} if request.url.path.endswith("/agents") else row)

    with Arkova(api_key="ak_caller", transport=httpx.MockTransport(handler)) as client:
        rows = client.list_agents().agents
        assert len(rows) == 2
        assert rows[0].metadata == {}
        assert client.get_agent(AGENT_ID).metadata == {}

    async def check() -> None:
        async with AsyncArkova(api_key="ak_caller", transport=httpx.MockTransport(handler)) as client:
            rows = (await client.list_agents()).agents
            assert len(rows) == 2
            assert rows[0].metadata == {}
            assert (await client.get_agent(AGENT_ID)).metadata == {}
    asyncio.run(check())


@pytest.mark.parametrize("metadata", [[], "invalid", 7])
def test_non_object_agent_metadata_remains_invalid(metadata: object) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"agents": [{**AGENT, "metadata": metadata}]})
    with (
        Arkova(api_key="ak_caller", transport=httpx.MockTransport(handler)) as client,
        pytest.raises(ArkovaError),
    ):
        client.list_agents()
