import { describe, expect, it } from "vitest";

import { EmptyBatch, EmptyContent, HallmarqError, InvalidHex, InvalidUtf8 } from "./errors.js";

describe("HallmarqError subclasses", () => {
  it("InvalidUtf8 has a stable code, a default message, and is a HallmarqError", () => {
    const error = new InvalidUtf8();
    expect(error).toBeInstanceOf(HallmarqError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("InvalidUtf8");
    expect(error.code).toBe("INVALID_UTF8");
    expect(error.message).toBe("Input is not valid UTF-8");
  });

  it("InvalidUtf8 accepts a custom message", () => {
    expect(new InvalidUtf8("custom").message).toBe("custom");
  });

  it("EmptyContent has a stable code and is a HallmarqError", () => {
    const error = new EmptyContent();
    expect(error).toBeInstanceOf(HallmarqError);
    expect(error.name).toBe("EmptyContent");
    expect(error.code).toBe("EMPTY_CONTENT");
  });

  it("EmptyContent accepts a custom message", () => {
    expect(new EmptyContent("custom").message).toBe("custom");
  });

  it("EmptyBatch has a stable code and is a HallmarqError", () => {
    const error = new EmptyBatch();
    expect(error).toBeInstanceOf(HallmarqError);
    expect(error.name).toBe("EmptyBatch");
    expect(error.code).toBe("EMPTY_BATCH");
  });

  it("EmptyBatch accepts a custom message", () => {
    expect(new EmptyBatch("custom").message).toBe("custom");
  });

  it("InvalidHex has a stable code and is a HallmarqError", () => {
    const error = new InvalidHex();
    expect(error).toBeInstanceOf(HallmarqError);
    expect(error.name).toBe("InvalidHex");
    expect(error.code).toBe("INVALID_HEX");
  });

  it("InvalidHex accepts a custom message", () => {
    expect(new InvalidHex("custom").message).toBe("custom");
  });
});
