import { expect, test, vi } from "vitest";
const { feed } = vi.hoisted(() => ({
  feed: { value: null as null | { owner: string; repo: string; private: true } },
}));
vi.mock("../bundled-setup.js", () => ({ getBundledUpdateFeed: () => feed.value }));
import { configureBundledUpdateFeed } from "./bundled-update-feed.js";

test("ordinary core builds keep their updater and do not request GitHub credentials", async () => {
  feed.value = null;
  const token = vi.fn(async () => "synthetic_credential_12345");
  const updater = { setFeedURL: vi.fn() };
  await configureBundledUpdateFeed(updater, token);
  expect(token).not.toHaveBeenCalled();
  expect(updater.setFeedURL).not.toHaveBeenCalled();
});
test("a private distribution uses local credentials only at update-check time", async () => {
  feed.value = { owner: "example", repo: "distribution", private: true };
  const updater = { setFeedURL: vi.fn() };
  await configureBundledUpdateFeed(updater, async () => "synthetic_credential_12345");
  expect(updater.setFeedURL).toHaveBeenCalledWith({
    provider: "github",
    ...feed.value,
    token: "synthetic_credential_12345",
  });
  await expect(configureBundledUpdateFeed(updater, async () => "invalid\nvalue")).rejects.toThrow(
    "인증",
  );
  expect(updater.setFeedURL).toHaveBeenCalledTimes(1);
});
