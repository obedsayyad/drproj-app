import http from "node:http";
import type { AddressInfo } from "node:net";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createMetrics } from "./metrics.js";

const BASE = { SUPABASE_APP_URL: "postgres://h/db", INSTANCE_ID: "abc-1" };

async function get(env: Record<string, string>) {
  const config = loadConfig({ ...BASE, ...env });
  const pool = {
    connect: async () => {
      throw new Error("db touched");
    },
    query: async () => {
      throw new Error("db touched");
    },
  } as unknown as pg.Pool;
  const server = http.createServer(
    createApp({
      config,
      pool,
      metrics: createMetrics("t", "v"),
      workload: null,
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/instance`,
    );
    return { res, body: (await res.json()) as Record<string, unknown> };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

describe("instance identity (display only)", () => {
  it("exposes label, provider and region without the database, as headers and at /api/instance", async () => {
    const { res, body } = await get({
      INSTANCE_ROLE: "warm",
      INSTANCE_PROVIDER: "digitalocean",
      INSTANCE_REGION: "fra1 (Frankfurt)",
      INSTANCE_LABEL: "Backup server",
    });
    expect(body).toMatchObject({
      instance_id: "abc-1",
      role: "warm",
      provider: "digitalocean",
      region: "fra1 (Frankfurt)",
      label: "Backup server",
    });
    expect(res.headers.get("x-instance-label")).toBe("Backup%20server");
    expect(decodeURIComponent(res.headers.get("x-instance-region")!)).toBe(
      "fra1 (Frankfurt)",
    );
    expect(res.headers.get("x-instance-provider")).toBe("digitalocean");
  });

  it("is absent, not invented, when the env is not set; rejects values that could carry markup or addresses-as-headers", async () => {
    const { res, body } = await get({});
    expect(body).toMatchObject({
      role: null,
      provider: null,
      region: null,
      label: null,
    });
    expect(res.headers.get("x-instance-label")).toBeNull();
    expect(() => loadConfig({ ...BASE, INSTANCE_LABEL: "<b>x</b>" })).toThrow(
      /INSTANCE_LABEL/,
    );
    expect(() => loadConfig({ ...BASE, INSTANCE_PROVIDER: "aws" })).toThrow(
      /INSTANCE_PROVIDER/,
    );
  });
});
