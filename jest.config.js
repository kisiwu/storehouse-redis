const { createDefaultPreset } = require("ts-jest");

const tsJestTransformCfg = createDefaultPreset().transform;

/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  transform: {
    ...tsJestTransformCfg,
  },
  // Setup files to be run before the test framework is installed
  setupFiles: ["<rootDir>/jest.setup.js"],
};