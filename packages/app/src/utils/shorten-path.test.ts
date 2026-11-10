import { describe, expect, it } from "vitest";
import { shortenPath } from "./shorten-path";

describe("shortenPath", () => {
  it("shortens a macOS home directory path", () => {
    expect(shortenPath("/Users/moboudra/dev/paseo")).toBe("~/dev/paseo");
  });

  it("shortens a Linux home directory path", () => {
    expect(shortenPath("/home/moboudra/dev/paseo")).toBe("~/dev/paseo");
  });

  it("leaves non-home absolute paths unchanged", () => {
    expect(shortenPath("/var/www/app")).toBe("/var/www/app");
  });

  it("shortens Windows home paths while keeping their separators", () => {
    expect(shortenPath("C:\\Users\\moboudra\\dev\\paseo")).toBe("~\\dev\\paseo");
    expect(shortenPath("D:/Users/moboudra/dev/paseo")).toBe("~/dev/paseo");
    expect(shortenPath("c:\\users\\moboudra")).toBe("~");
  });

  it("shortens exact homes and the Linux root home without matching adjacent paths", () => {
    expect(shortenPath("/home/ubuntu")).toBe("~");
    expect(shortenPath("/root/projects")).toBe("~/projects");
    expect(shortenPath("/rooted/projects")).toBe("/rooted/projects");
  });

  it("preserves shared Windows folders and non-home locations", () => {
    expect(shortenPath("C:\\Users\\Public\\Projects")).toBe("C:\\Users\\Public\\Projects");
    expect(shortenPath("C:/Users/Default/Desktop")).toBe("C:/Users/Default/Desktop");
    expect(shortenPath("C:\\work\\repo")).toBe("C:\\work\\repo");
  });

  it("returns an empty string for null or undefined", () => {
    expect(shortenPath(null)).toBe("");
    expect(shortenPath(undefined)).toBe("");
  });

  it("returns an empty string for an empty string", () => {
    expect(shortenPath("")).toBe("");
  });
});
