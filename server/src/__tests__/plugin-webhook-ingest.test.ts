import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  upsertConfig: vi.fn(),
  getCompanySettings: vi.fn(),
  upsertCompanySettings: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const pluginId = "11111111-1111-4111-8111-111111111111";
const endpointKey = "incoming";

function readyPlugin(overrides: Record<string, unknown> = {}) {
  return {
    id: pluginId,
    pluginKey: "paperclip.example",
    version: "1.0.0",
    status: "ready",
    manifestJson: {
      id: "paperclip.example",
      version: "1.0.0",
      capabilities: ["webhooks.receive"],
      webhooks: [{ endpointKey, path: "/hook" }],
    },
    ...overrides,
  };
}

function makeInsertDb(deliveryId = "delivery-1") {
  const returning = vi.fn(() => Promise.resolve([{ id: deliveryId }]));
  const values = vi.fn(() => ({ returning }));
  const insert = vi.fn(() => ({ values }));
  const set = vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) }));
  const update = vi.fn(() => ({ set }));
  return { db: { insert, update } as never, insert, values, returning, update, set };
}

async function buildApp(deps: {
  db: unknown;
  workerCall?: ReturnType<typeof vi.fn>;
}) {
  const [{ pluginRoutes, __resetWebhookRateLimiterForTests }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);
  __resetWebhookRateLimiterForTests();
  const app = express();
  // Mirror the prod parser: capture rawBody for HMAC and apply a small limit.
  app.use(
    express.json({
      limit: 256_000,
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  // Mirror the prod 413 normalizer so oversize bodies surface as 413.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && typeof err === "object" && (err as { type?: string }).type === "entity.too.large") {
      res.status(413).json({ error: "Request entity too large" });
      return;
    }
    next(err);
  });
  // No actor middleware: webhook route is intentionally unauthenticated.
  const workerCall = deps.workerCall ?? vi.fn().mockResolvedValue(undefined);
  app.use(
    "/api",
    pluginRoutes(
      deps.db as never,
      { installPlugin: vi.fn() } as never,
      undefined,
      { workerManager: { call: workerCall } } as never,
      undefined,
      undefined,
    ),
  );
  app.use(errorHandler);
  return { app, workerCall };
}

describe.sequential("plugin webhook ingestion hardening (MAT-661 F2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 and persists delivery on the happy path", async () => {
    mockRegistry.getById.mockResolvedValue(readyPlugin());
    const { db, insert, update } = makeInsertDb();
    const { app, workerCall } = await buildApp({ db });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .set("X-Forwarded-For", "10.0.0.1")
      .send({ hello: "world" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("success");
    expect(insert).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(workerCall).toHaveBeenCalledWith(pluginId, "handleWebhook", expect.objectContaining({
      endpointKey,
      rawBody: expect.stringContaining("hello"),
    }));
  });

  it("collapses unknown plugin to generic 404 without DB insert", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    const { db, insert } = makeInsertDb();
    const { app } = await buildApp({ db });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Webhook not delivered" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("collapses not-ready plugin to generic 404 without DB insert", async () => {
    mockRegistry.getById.mockResolvedValue(readyPlugin({ status: "installing" }));
    const { db, insert } = makeInsertDb();
    const { app } = await buildApp({ db });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Webhook not delivered" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("collapses missing capability to generic 404 without DB insert", async () => {
    mockRegistry.getById.mockResolvedValue(
      readyPlugin({ manifestJson: { id: "x", version: "1", capabilities: [], webhooks: [{ endpointKey, path: "/h" }] } }),
    );
    const { db, insert } = makeInsertDb();
    const { app } = await buildApp({ db });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Webhook not delivered" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("collapses undeclared endpointKey to generic 404 without DB insert", async () => {
    mockRegistry.getById.mockResolvedValue(readyPlugin());
    const { db, insert } = makeInsertDb();
    const { app } = await buildApp({ db });

    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/some-other-key`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Webhook not delivered" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("rate-limits per (plugin, IP) after 30 deliveries / minute", async () => {
    mockRegistry.getById.mockResolvedValue(readyPlugin());
    const { db, insert } = makeInsertDb();
    const { app } = await buildApp({ db });
    const agent = request.agent(app);

    // 30 successes in burst, then 31st should be 429.
    for (let i = 0; i < 30; i += 1) {
      const ok = await agent
        .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
        .send({ i });
      expect(ok.status).toBe(200);
    }
    const limited = await agent
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send({});
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.body.error).toMatch(/Too many/);
    // No extra DB insert for the throttled request.
    expect(insert).toHaveBeenCalledTimes(30);
  }, 20_000);

  it("rejects oversize payload with 413 from the parser", async () => {
    mockRegistry.getById.mockResolvedValue(readyPlugin());
    const { db, insert } = makeInsertDb();
    const { app } = await buildApp({ db });

    // 300 KB body — exceeds the 256 KB parser limit.
    const big = { blob: "x".repeat(300_000) };
    const res = await request(app)
      .post(`/api/plugins/${pluginId}/webhooks/${endpointKey}`)
      .send(big);

    expect(res.status).toBe(413);
    expect(insert).not.toHaveBeenCalled();
  });
});
