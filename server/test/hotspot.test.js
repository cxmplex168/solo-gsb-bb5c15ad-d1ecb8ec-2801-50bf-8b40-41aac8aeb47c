"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  analyzeHotspots,
  MAX_SAMPLES,
  MAX_INSTANCES_PER_CLUSTER,
} = require("../hotspot");

const schema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
  required: ["id", "name"],
  additionalProperties: false,
};

test("analyzeHotspots clusters the same rule across array indexes into one hotspot", () => {
  const { clusters } = analyzeHotspots({
    schema,
    samples: [
      { id: 1, name: "a", tags: ["ok", 1, true] }, // two item errors, same rule
      { id: 2, name: "b", tags: [null] }, // one more, same rule
    ],
  });
  assert.equal(clusters.length, 1);
  const [cluster] = clusters;
  assert.equal(cluster.keyword, "type");
  assert.equal(cluster.schemaPath, "#/properties/tags/items/type");
  assert.equal(cluster.errorCount, 3);
  assert.equal(cluster.affectedSamples, 2);
  assert.deepEqual(cluster.sampleIndexes, [0, 1]);
  assert.deepEqual(
    cluster.instances.map((i) => [i.sampleIndex, i.pointer]),
    [
      [0, "/tags/1"],
      [0, "/tags/2"],
      [1, "/tags/0"],
    ]
  );
  assert.equal(cluster.instancesTruncated, false);
});

test("analyzeHotspots splits required errors per missingProperty", () => {
  const { clusters } = analyzeHotspots({
    schema: {
      type: "object",
      properties: { a: { type: "integer" }, b: { type: "integer" } },
      required: ["a", "b"],
    },
    samples: [{}, { a: 1 }, {}],
  });
  assert.equal(clusters.length, 2);
  const byProp = new Map(clusters.map((c) => [c.missingProperty, c]));
  const a = byProp.get("a");
  const b = byProp.get("b");
  assert.ok(a && b);
  assert.equal(a.keyword, "required");
  assert.equal(a.schemaPath, "#/required");
  assert.deepEqual(a.sampleIndexes, [0, 2]); // missing in #0 and #2
  assert.equal(a.affectedSamples, 2);
  assert.equal(a.errorCount, 2);
  assert.deepEqual(b.sampleIndexes, [0, 1, 2]); // missing in all three
  assert.equal(b.affectedSamples, 3);
  // Ranked by affected sample count: b (3 samples) before a (2 samples).
  assert.equal(clusters[0].missingProperty, "b");
  assert.equal(clusters[1].missingProperty, "a");
  // Every required instance points at the object that lacks the property.
  assert.ok(a.instances.every((i) => i.pointer === "(root)"));
});

test("analyzeHotspots splits additionalProperties errors per additionalProperty", () => {
  const { clusters } = analyzeHotspots({
    schema: { type: "object", properties: { id: { type: "integer" } }, additionalProperties: false },
    samples: [{ id: 1, x: 1, y: 2 }, { id: 2, x: 3 }],
  });
  assert.equal(clusters.length, 2);
  const byProp = new Map(clusters.map((c) => [c.additionalProperty, c]));
  assert.equal(byProp.get("x").errorCount, 2);
  assert.deepEqual(byProp.get("x").sampleIndexes, [0, 1]);
  assert.equal(byProp.get("y").errorCount, 1);
  assert.deepEqual(byProp.get("y").sampleIndexes, [0]);
  assert.equal(clusters[0].additionalProperty, "x"); // 2 affected samples first
});

test("analyzeHotspots tallies totals and ranks clusters by affected samples", () => {
  const { total, validSamples, invalidSamples, errorCount, clusterCount, clusters } =
    analyzeHotspots({
      schema,
      samples: [
        { id: 1, name: "ok", tags: ["a"] }, // valid
        { id: "x", name: "bad id" }, // one type error
        { name: "no id", extra: true }, // required(id) + additionalProperties(extra)
      ],
    });
  assert.equal(total, 3);
  assert.equal(validSamples, 1);
  assert.equal(invalidSamples, 2);
  assert.equal(errorCount, 3);
  assert.equal(clusterCount, 3);
  // Every cluster here affects exactly one sample; ties break on error count
  // (all 1) and then on the cluster id, keeping the order deterministic.
  assert.ok(clusters.every((c) => c.affectedSamples === 1));
  const ids = clusters.map((c) => c.id);
  assert.deepEqual(ids, [...ids].sort());
});

test("analyzeHotspots accepts an empty sample set", () => {
  const result = analyzeHotspots({ schema, samples: [] });
  assert.equal(result.total, 0);
  assert.equal(result.validSamples, 0);
  assert.equal(result.invalidSamples, 0);
  assert.equal(result.errorCount, 0);
  assert.equal(result.clusterCount, 0);
  assert.deepEqual(result.clusters, []);
});

test(`analyzeHotspots truncates instances beyond ${MAX_INSTANCES_PER_CLUSTER} per cluster`, () => {
  const big = {
    type: "object",
    properties: { xs: { type: "array", items: { type: "string" } } },
    required: ["xs"],
  };
  const sample = { xs: Array.from({ length: MAX_INSTANCES_PER_CLUSTER + 5 }, () => 1) };
  const { clusters } = analyzeHotspots({ schema: big, samples: [sample] });
  assert.equal(clusters.length, 1);
  const [cluster] = clusters;
  assert.equal(cluster.errorCount, MAX_INSTANCES_PER_CLUSTER + 5);
  assert.equal(cluster.affectedSamples, 1);
  assert.equal(cluster.instances.length, MAX_INSTANCES_PER_CLUSTER);
  assert.equal(cluster.instancesTruncated, true);
});

test("analyzeHotspots rejects invalid input shapes with status 400", () => {
  for (const body of [
    { samples: [] },
    { schema: null, samples: [] },
    { schema: [1], samples: [] },
    { schema: {}, samples: undefined },
    { schema: {}, samples: "nope" },
    { schema: {}, samples: { 0: 1 } },
  ]) {
    assert.throws(
      () => analyzeHotspots(body),
      (err) => err.status === 400
    );
  }
});

test(`analyzeHotspots rejects more than ${MAX_SAMPLES} samples with status 400`, () => {
  const samples = Array.from({ length: MAX_SAMPLES + 1 }, () => 1);
  assert.throws(
    () => analyzeHotspots({ schema: {}, samples }),
    (err) => err.status === 400 && new RegExp(`${MAX_SAMPLES}`).test(err.message)
  );
  // Exactly at the limit is fine.
  const ok = analyzeHotspots({
    schema: {},
    samples: Array.from({ length: MAX_SAMPLES }, () => 1),
  });
  assert.equal(ok.total, MAX_SAMPLES);
  assert.equal(ok.validSamples, MAX_SAMPLES);
});

test("analyzeHotspots rejects an uncompilable schema with status 422", () => {
  assert.throws(
    () => analyzeHotspots({ schema: { type: "not-a-type" }, samples: [1] }),
    (err) => err.status === 422 && /Invalid schema/.test(err.message)
  );
});
