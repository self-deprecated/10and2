/* Mono 16-bit PCM in, AAC-LC in ADTS frames out: what the phones play and cache today (reading-engine.md). A thin
   wrapper over the Fraunhofer FDK AAC encoder, built to aac.wasm by build.sh; aac.ts drives it. Not part of the FDK
   AAC library itself, which is used unmodified. */
#include <stdlib.h>
#include "aacenc_lib.h"

#define EXPORT __attribute__((used, visibility("default")))

typedef struct {
  HANDLE_AACENCODER h;
  INT_PCM *in;
  int inCap;
  UCHAR *out;
  int outLen, outCap, frameBytes;
} Enc;

/* An encoder at `rate` Hz and `bitrate` bit/s (constant), or 0. */
EXPORT Enc *aac_open(int rate, int bitrate) {
  Enc *e = calloc(1, sizeof(Enc));
  if (!e || aacEncOpen(&e->h, 0, 1) != AACENC_OK) return free(e), (Enc *)0;
  AACENC_InfoStruct info;
  if (aacEncoder_SetParam(e->h, AACENC_AOT, AOT_AAC_LC) != AACENC_OK
      || aacEncoder_SetParam(e->h, AACENC_SAMPLERATE, rate) != AACENC_OK
      || aacEncoder_SetParam(e->h, AACENC_CHANNELMODE, MODE_1) != AACENC_OK
      || aacEncoder_SetParam(e->h, AACENC_BITRATE, bitrate) != AACENC_OK
      || aacEncoder_SetParam(e->h, AACENC_TRANSMUX, TT_MP4_ADTS) != AACENC_OK
      || aacEncoder_SetParam(e->h, AACENC_AFTERBURNER, 0) != AACENC_OK
      || aacEncEncode(e->h, NULL, NULL, NULL, NULL) != AACENC_OK
      || aacEncInfo(e->h, &info) != AACENC_OK) {
    aacEncClose(&e->h);
    free(e);
    return 0;
  }
  e->frameBytes = info.maxOutBufBytes;
  return e;
}

/* Room for `n` samples, written by the caller before aac_encode(n). */
EXPORT INT_PCM *aac_input(Enc *e, int n) {
  if (n > e->inCap) {
    INT_PCM *p = realloc(e->in, n * sizeof(INT_PCM));
    if (!p) return 0;
    e->in = p;
    e->inCap = n;
  }
  return e->in;
}

/* Encodes `n` samples from the input (n < 0: the end, flushing what's held back). Bytes waiting in the output, or a
   negative error. */
EXPORT int aac_encode(Enc *e, int n) {
  int used = 0, inId = IN_AUDIO_DATA, outId = OUT_BITSTREAM_DATA, inEl = sizeof(INT_PCM), outEl = 1;
  for (;;) {
    if (e->outCap - e->outLen < e->frameBytes) {
      int cap = e->outCap ? e->outCap * 2 : 1 << 16;
      UCHAR *p = realloc(e->out, cap);
      if (!p) return -AACENC_MEMORY_ERROR;
      e->out = p;
      e->outCap = cap;
    }
    void *inPtr = e->in + used, *outPtr = e->out + e->outLen;
    int inSize = n < 0 ? 0 : (n - used) * (int)sizeof(INT_PCM), outSize = e->outCap - e->outLen;
    AACENC_BufDesc inDesc = {1, &inPtr, &inId, &inSize, &inEl}, outDesc = {1, &outPtr, &outId, &outSize, &outEl};
    AACENC_InArgs inArgs = {n < 0 ? -1 : n - used, 0};
    AACENC_OutArgs outArgs = {0};
    AACENC_ERROR err = aacEncEncode(e->h, &inDesc, &outDesc, &inArgs, &outArgs);
    if (err == AACENC_ENCODE_EOF) break;
    if (err != AACENC_OK) return -(int)err;
    used += outArgs.numInSamples;
    e->outLen += outArgs.numOutBytes;
    if (n >= 0 && (used >= n || !outArgs.numInSamples) && !outArgs.numOutBytes) break;
  }
  return e->outLen;
}

EXPORT UCHAR *aac_output(Enc *e) { return e->out; }

/* The caller has copied the output away. */
EXPORT void aac_taken(Enc *e) { e->outLen = 0; }

EXPORT void aac_close(Enc *e) {
  aacEncClose(&e->h);
  free(e->in);
  free(e->out);
  free(e);
}
