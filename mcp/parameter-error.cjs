"use strict";

// Use only static guidance here: runtime errors can contain private input or paths.
class ParameterError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParameterError";
  }
}

module.exports = { ParameterError };
