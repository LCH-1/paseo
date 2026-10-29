import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getBundledUpdateFeed } from "../bundled-setup.js";

const execute = promisify(execFile);
export async function configureBundledUpdateFeed(
  updater: {
    setFeedURL(options: {
      provider: "github";
      owner: string;
      repo: string;
      private: true;
      token: string;
    }): void;
  },
  readToken = async () => {
    try {
      const result = await execute("gh", ["auth", "token", "--hostname", "github.com"], {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 16384,
      });
      return result.stdout.trim();
    } catch {
      throw new Error(
        "Paseo 업데이트를 확인하려면 배포 저장소에 접근할 수 있는 GitHub 로그인이 필요합니다.",
      );
    }
  },
) {
  const feed = getBundledUpdateFeed();
  if (!feed) return;
  const token = await readToken();
  if (!/^[\w-]{20,4096}$/.test(token)) throw new Error("GitHub 업데이트 인증을 확인하세요.");
  updater.setFeedURL({ provider: "github", ...feed, token });
}
