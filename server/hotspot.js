"use strict";

/**
 * Error hotspot aggregator.
 *
 * Every pasted sample is validated with Ajv (allErrors) against the current
 * schema and the resulting errors are clustered by RULE: the cluster key is
 * the Ajv `schemaPath` plus the `keyword`, so the same rule firing at
 * different array indexes (e.g. `/tags/0` vs `/tags/1`) lands in one
 * cluster. Two keywords carry a param that picks a sub-rule and must NOT be
 * merged: `required` splits per `missingProperty` and
 * `additionalProperties` splits per `additionalProperty`.
 *
 * Each cluster reports the affected sample count, the total error count,
 * the affected sample indexes and the original instance pointers, and the
 * clusters are ranked by affected sample count (descending).
 *
 * A single run is capped at MAX_SAMPLES samples; the route surfaces shape
 * violations as 400 and an uncompilable schema as 422.
 */

const Ajv2020 = require("ajv/dist/2020").default;

const MAX_SAMPLES = 200;
const MAX_INSTANCES_PER_CLUSTER = 100;

const ajv = new Ajv2020({ allErrors: true, strict: false });

// Keywords whose params identify a sub-rule that forms its own cluster.
const SPLIT_PARAMS = {
  required: "missingProperty",
  additionalProperties: "additionalProperty",
};

/**
 * The sub-rule discriminator for an error, or null when the keyword is
 * clustered purely by schemaPath + keyword.
 */
function discriminatorOf(error) {
  const param = SPLIT_PARAMS[error.keyword];
  if (!param || !error.params) return null;
  const value = error.params[param];
  return value === undefined ? null : String(value);
}

function clusterKeyOf(error) {
  const discriminator = discriminatorOf(error);
  const base = `${error.schemaPath}#${error.keyword}`;
  return discriminator === null ? base : `${base}#${discriminator}`;
}

/**
 * Validate every sample against the schema and cluster the errors by rule.
 *
 * @returns {{ total: number, validSamples: number, invalidSamples: number,
 *            errorCount: number, clusterCount: number,
 *            clusters: Array<object> }}
 */
function analyzeHotspots({ schema, samples }) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw Object.assign(new Error("Request body must contain a 'schema' object."), {
      status: 400,
    });
  }
  if (!Array.isArray(samples)) {
    throw Object.assign(new Error("Request body must contain a 'samples' array."), {
      status: 400,
    });
  }
  if (samples.length > MAX_SAMPLES) {
    throw Object.assign(
      new Error(
        `Too many samples: got ${samples.length}, at most ${MAX_SAMPLES} allowed per hotspot analysis.`
      ),
      { status: 400 }
    );
  }

  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    throw Object.assign(new Error(`Invalid schema: ${err.message}`), { status: 422 });
  }

  const clusters = new Map(); // key -> accumulator
  let validSamples = 0;
  let errorCount = 0;

  samples.forEach((sample, sampleIndex) => {
    const valid = validate(sample);
    if (valid) {
      validSamples += 1;
      return;
    }
    const errors = validate.errors || [];
    errorCount += errors.length;
    for (const error of errors) {
      const key = clusterKeyOf(error);
      let cluster = clusters.get(key);
      if (!cluster) {
        cluster = {
          id: key,
          schemaPath: error.schemaPath,
          keyword: error.keyword,
          errorCount: 0,
          sampleIndexSet: new Set(),
          instances: [],
          instancesTruncated: false,
        };
        const discriminator = discriminatorOf(error);
        if (discriminator !== null) {
          const param = SPLIT_PARAMS[error.keyword];
          cluster[param] = discriminator;
        }
        clusters.set(key, cluster);
      }
      cluster.errorCount += 1;
      cluster.sampleIndexSet.add(sampleIndex);
      if (cluster.instances.length >= MAX_INSTANCES_PER_CLUSTER) {
        cluster.instancesTruncated = true;
      } else {
        cluster.instances.push({
          sampleIndex,
          pointer: error.instancePath || "(root)",
          message: error.message,
          params: error.params,
        });
      }
    }
  });

  const ranked = [...clusters.values()]
    .map((cluster) => ({
      id: cluster.id,
      schemaPath: cluster.schemaPath,
      keyword: cluster.keyword,
      ...(cluster.missingProperty !== undefined
        ? { missingProperty: cluster.missingProperty }
        : {}),
      ...(cluster.additionalProperty !== undefined
        ? { additionalProperty: cluster.additionalProperty }
        : {}),
      affectedSamples: cluster.sampleIndexSet.size,
      errorCount: cluster.errorCount,
      sampleIndexes: [...cluster.sampleIndexSet].sort((a, b) => a - b),
      instances: cluster.instances,
      instancesTruncated: cluster.instancesTruncated,
    }))
    // Hotspots first: most affected samples, then most errors; the key
    // tiebreak keeps the order deterministic.
    .sort(
      (a, b) =>
        b.affectedSamples - a.affectedSamples ||
        b.errorCount - a.errorCount ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );

  return {
    total: samples.length,
    validSamples,
    invalidSamples: samples.length - validSamples,
    errorCount,
    clusterCount: ranked.length,
    clusters: ranked,
  };
}

module.exports = { analyzeHotspots, MAX_SAMPLES, MAX_INSTANCES_PER_CLUSTER };
