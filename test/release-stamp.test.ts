import assert from "node:assert/strict";
import test from "node:test";

import { changelogUrl, parseReleaseStamp, stampUrl } from "../src/core/release.ts";

const good = {
  version: "0.2.0",
  commit: "86d5a1d",
  builtAt: "2026-09-11T15:54:22.382Z",
  upstream: "madbarbarian/Affiliate-Management-Platform-release",
};

test("a copy that knows what it is can be compared against what is current", () => {
  const stamp = parseReleaseStamp(JSON.stringify(good));
  assert.deepEqual(stamp, good);
});

test("the file manifest beside the identity is ignored, not rejected", () => {
  // RELEASE.json is one file doing two jobs: what a licensee received (187
  // entries with hashes) and which copy this is. Reading the second must not
  // depend on the shape of the first.
  const stamp = parseReleaseStamp(
    JSON.stringify({ ...good, name: "affiliate-management-platform", files: [{ path: "README.md", bytes: 1, sha256: "x" }] }),
  );
  assert.equal(stamp?.commit, "86d5a1d");
});

test("half a stamp is treated as no stamp", () => {
  // Silence is the safe failure here. A stamp missing `upstream` has nothing to
  // compare against, and one missing `commit` would report every check as a
  // difference - so a licensee would be told, forever, that they are behind.
  for (const missing of ["version", "commit", "builtAt", "upstream"] as const) {
    const partial: Record<string, string> = { ...good };
    delete partial[missing];
    assert.equal(parseReleaseStamp(JSON.stringify(partial)), undefined, `${missing} missing`);
  }
});

test("a release built without git says nothing rather than saying it is behind", () => {
  // make-release writes "unknown" when git cannot answer. Treating that as an
  // identity would make every comparison a difference.
  assert.equal(parseReleaseStamp(JSON.stringify({ ...good, commit: "unknown" })), undefined);
});

test("a stamp the licensee mangled costs them the notice and nothing else", () => {
  // This file lives in their own repository. They can edit it, truncate it, or
  // replace it with their lunch order. None of that may throw on a path the
  // console is on.
  for (const junk of ["", "not json", "null", "[]", '"a string"', "{", JSON.stringify(42)]) {
    assert.equal(parseReleaseStamp(junk), undefined, JSON.stringify(junk));
  }
});

test("upstream cannot point the fetch somewhere else", () => {
  // The value is interpolated into a URL the Worker fetches. A stamp someone
  // edited must not be able to move that fetch to another host, walk out of the
  // repository path, or smuggle a query string onto it.
  const hostile = [
    "evil.example.com/a/b",
    "../../etc/passwd",
    "owner/repo/../../other",
    "owner/repo?x=1",
    "owner/repo#frag",
    "owner",
    "owner/repo/extra",
    "own er/repo",
    "@evil.com/owner/repo",
  ];
  for (const upstream of hostile) {
    assert.equal(parseReleaseStamp(JSON.stringify({ ...good, upstream })), undefined, upstream);
  }
});

test("the published locations need no credential", () => {
  // raw.githubusercontent.com, not the API: a licensee's Worker holds no GitHub
  // token, and asking them to make one to learn that a fix exists would put the
  // notice behind exactly the step it is meant to remove.
  assert.equal(
    stampUrl(good.upstream),
    "https://raw.githubusercontent.com/madbarbarian/Affiliate-Management-Platform-release/main/RELEASE.json",
  );
  assert.equal(
    changelogUrl(good.upstream),
    "https://raw.githubusercontent.com/madbarbarian/Affiliate-Management-Platform-release/main/CHANGELOG.md",
  );
});
