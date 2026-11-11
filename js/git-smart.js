// Smart-HTTP transport routing (docs/git-over-ipfs.md phase 9 step 3).
// Pure: turns a GitStore into an isomorphic-git `http` client whose
// requests are answered by the in-process upload-pack — no sockets. The
// URL is decorative (isomorphic-git wants an http(s)-shaped one); the
// store is the actual remote.

import { uploadPackRefs, parseUploadPackRequest, uploadPack } from './git-upload-pack.js';

export function makeSmartHttp(store) {
  return {
    async request({ url, method, headers, body }) {
      // isomorphic-git's StreamReader expects an ITERABLE OF CHUNKS; a
      // bare Uint8Array iterates as numbers and dies as "empty response".
      if (url.includes('info/refs')) {
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
          body: [uploadPackRefs(store)]
        };
      }
      const { wants, haves, done, caps } = parseUploadPackRequest(body);
      const out = uploadPack(store, wants, haves, { done, caps });
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/x-git-upload-pack-result' },
        body: [out.body]
      };
    }
  };
}
