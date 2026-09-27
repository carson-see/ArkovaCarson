import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import express from "express";
import request from "supertest";
import { docsRouter, openApiSpec } from "./docs.js";
import {
  agentOpenApiResponses,
  agentOpenApiSchemas,
} from "./agents.openapi.js";

const yaml = readFileSync(
  new URL("../../../../../docs/api/openapi.yaml", import.meta.url),
  "utf8",
);
const yamlSpec = load(yaml) as typeof openApiSpec;
const paths = [
  "/agents",
  "/agents/{agentId}",
  "/agents/{agentId}/key",
  "/agents/computeid/admit",
] as const;

describe("agent lifecycle OpenAPI contract", () => {
  it("publishes all seven operations in the served and YAML specifications", () => {
    for (const path of paths) {
      expect(openApiSpec.paths[path]).toBeDefined();
      expect(yaml).toContain(`  ${path}:`);
    }
    expect(Object.keys(openApiSpec.paths["/agents"])).toEqual(
      expect.arrayContaining(["get", "post"]),
    );
    expect(Object.keys(openApiSpec.paths["/agents/{agentId}"])).toEqual(
      expect.arrayContaining(["get", "patch", "delete"]),
    );
    expect(openApiSpec.paths["/agents/{agentId}/key"].post).toBeDefined();
    expect(openApiSpec.paths["/agents/computeid/admit"].post).toBeDefined();
  });

  it("keeps every owned path, schema, and response structurally aligned with the YAML mirror", () => {
    const normalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(normalize);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => key !== "description")
          .map(([key, child]) => [key, normalize(child)]),
      );
    };
    const mapSecurity = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(mapSecurity);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => [
          key === "SupabaseJWT"
            ? "bearerAuth"
            : key === "ApiKeyHeader"
            ? "apiKey"
            : key === "ApiKeyBearer"
            ? "apiKeyBearer"
            : key,
          mapSecurity(child),
        ]),
      );
    };
    for (const path of paths) {
      expect(normalize(mapSecurity(openApiSpec.paths[path]))).toEqual(
        normalize(yamlSpec.paths[path]),
      );
    }
    for (const name of Object.keys(agentOpenApiSchemas)) {
      expect(normalize(openApiSpec.components.schemas[name])).toEqual(
        normalize(yamlSpec.components.schemas[name]),
      );
    }
    for (const name of Object.keys(agentOpenApiResponses)) {
      expect(normalize(openApiSpec.components.responses[name])).toEqual(
        normalize(yamlSpec.components.responses[name]),
      );
    }
  });

  it("serves the same agent contract from the docs router", async () => {
    const app = express().use("/api/docs", docsRouter);
    const response = await request(app).get("/api/docs/spec.json");
    expect(response.status).toBe(200);
    for (const path of paths) expect(response.body.paths[path]).toBeDefined();
  });

  it("keeps ComputeID admission API-key-only and models the signed receipt plus one-time key", () => {
    const admit = openApiSpec.paths["/agents/computeid/admit"].post;
    expect(admit.security).toEqual([{ ApiKeyHeader: [] }, {
      ApiKeyBearer: [],
    }]);
    expect(admit["x-arkova-required-scopes"]).toEqual(["agents:manage"]);
    expect(
      openApiSpec.components.schemas.ComputeIdVerificationReceipt
        .additionalProperties,
    ).toBe(true);
    expect(openApiSpec.components.schemas.ComputeIdBinding.required).toContain(
      "receipt_expires_at",
    );
    expect(
      openApiSpec.components.schemas.ComputeIdAdmissionResult.properties.agent
        .$ref,
    ).toBe("#/components/schemas/ComputeIdAdmissionAgent");
    expect(openApiSpec.components.schemas.ComputeIdAdmissionResult.required)
      .toEqual(
        expect.arrayContaining([
          "agent",
          "binding",
          "key",
          "key_id",
          "key_prefix",
          "scopes",
          "warning",
        ]),
      );
  });

  it("documents nullable stored metadata without accepting non-objects", () => {
    expect(openApiSpec.components.schemas.Agent.properties.metadata)
      .toMatchObject({ type: "object", nullable: true });
  });

  it("matches the runtime scope bounds and registration default", () => {
    const create =
      openApiSpec.components.schemas.AgentCreate.properties.allowed_scopes;
    const update =
      openApiSpec.components.schemas.AgentUpdate.properties.allowed_scopes;
    const admission =
      openApiSpec.components.schemas.ComputeIdAdmissionRequest.properties
        .allowed_scopes;
    expect(create).toMatchObject({ minItems: 1, default: ["verify"] });
    expect(create).not.toHaveProperty("maxItems");
    expect(update).toMatchObject({ minItems: 1 });
    expect(update).not.toHaveProperty("maxItems");
    expect(admission).toMatchObject({ minItems: 1, maxItems: 32 });
  });

  it("resolves every served agent-contract component reference", () => {
    const refs: string[] = [];
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
        return;
      }
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string") refs.push(child);
        else walk(child);
      }
    };
    paths.forEach((path) => walk(openApiSpec.paths[path]));
    Object.values(agentOpenApiSchemas).forEach(walk);
    Object.values(agentOpenApiResponses).forEach(walk);
    for (const ref of refs) {
      expect(ref).toMatch(/^#\/components\/(schemas|responses)\/[A-Za-z0-9]+$/);
      const [, , section, name] = ref.split("/");
      expect(openApiSpec.components[section][name], ref).toBeDefined();
    }
  });
});
