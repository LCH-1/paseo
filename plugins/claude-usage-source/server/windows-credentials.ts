import { spawn } from "node:child_process";
import { join } from "node:path";

// Reuse Settings Sync's Claude CredMan format, including split credentials; read-only.
const SCRIPT = String.raw`$ErrorActionPreference='Stop'
try {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;
public static class PaseoProviderCredentials {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Credential { public UInt32 Flags; public UInt32 Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public UInt32 CredentialBlobSize; public IntPtr CredentialBlob; public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("advapi32.dll",EntryPoint="CredReadW",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ReadNative(string target,UInt32 type,UInt32 flags,out IntPtr value);
 [DllImport("advapi32.dll")] static extern void CredFree(IntPtr value);
 public static object Read(string target) { IntPtr pointer; if(!ReadNative(target,1,0,out pointer)) { if(Marshal.GetLastWin32Error()==1168)return null; throw new Win32Exception(); } try { var credential=(Credential)Marshal.PtrToStructure(pointer,typeof(Credential)); if(credential.CredentialBlobSize>1048576)throw new Exception(); var bytes=new byte[credential.CredentialBlobSize]; Marshal.Copy(credential.CredentialBlob,bytes,0,bytes.Length); long stamp=((long)(uint)credential.LastWritten.dwHighDateTime<<32)|(uint)credential.LastWritten.dwLowDateTime; return new {value=Convert.ToBase64String(bytes),updatedAt=(DateTime.FromFileTimeUtc(stamp)-new DateTime(1970,1,1)).TotalMilliseconds}; } finally { CredFree(pointer); } }
}
'@
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
switch($request.operation) {
 'read' { $result=[PaseoProviderCredentials]::Read($request.target); if($null -eq $result){[Console]::Out.Write('null')}else{[Console]::Out.Write(($result|ConvertTo-Json -Compress))} }
 default { throw 'operation' }
}
} catch { [Console]::Error.Write('Provider credential store failed.'); exit 1 }`;
export type ReadCredential = (target: string) => Promise<string | null>;

export const readCredential: ReadCredential = (target) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot ?? "C:/Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(SCRIPT, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!ok) {
        child.kill();
        reject(new Error("Claude Windows credential store could not be read"));
        return;
      }
      let value: string | null;
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        value = result === null ? null : Buffer.from(result.value, "base64").toString("utf8");
      } catch {
        reject(new Error("Invalid Claude Windows credential store response"));
        return;
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 2_097_152) finish(false);
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin.on("error", () => finish(false));
    child.stdin.end(JSON.stringify({ operation: "read", target }));
  });

export async function readWindowsCredentials(
  service: string,
  read: ReadCredential = readCredential,
): Promise<unknown | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readWindowsSnapshot(service, read);
    } catch (error) {
      const changing =
        error instanceof SyntaxError ||
        (error instanceof Error &&
          /^(?:Invalid split|Incomplete split|Changed split)/.test(error.message));
      if (!changing || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 75));
    }
  }
}

async function readWindowsSnapshot(service: string, read: ReadCredential): Promise<unknown | null> {
  const name = service + "/claude-code-user";
  const meta = await read(name + "#m");
  if (!meta) {
    const raw = await read(name);
    return raw === null ? null : JSON.parse(raw);
  }
  const info = JSON.parse(meta);
  if (
    !info ||
    typeof info !== "object" ||
    !Number.isInteger(info.n) ||
    info.n < 1 ||
    info.n > 256 ||
    !Number.isInteger(info.l) ||
    info.l < 1 ||
    info.l > info.n * 2400
  )
    throw new Error("Invalid split Claude Windows credential metadata");
  const chunks = await Promise.all(
    Array.from({ length: info.n }, (_, index) => read(name + "#" + index)),
  );
  const encoded = chunks.map((chunk) => chunk ?? "").join("");
  if (chunks.some((chunk) => chunk === null) || encoded.length !== info.l)
    throw new Error("Incomplete split Claude Windows credentials");
  if ((await read(name + "#m")) !== meta)
    throw new Error("Changed split Claude Windows credentials");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}
