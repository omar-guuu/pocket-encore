"""Decodes a compressed stem (MP3, FLAC, OGG/Vorbis, or WAV) to a 32-bit float WAV at its own rate and channels,
so prepwav.js can level/resample it. Uses miniaudio (pip install miniaudio).

    python decode.py <in.mp3|flac|ogg|wav> <out.wav>"""
import struct, sys
import miniaudio

src, dst = sys.argv[1], sys.argv[2]
s = miniaudio.decode_file(src, output_format=miniaudio.SampleFormat.FLOAT32)
data = s.samples.tobytes()
ch, sr = s.nchannels, s.sample_rate
with open(dst, "wb") as f:
    f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE")
    f.write(b"fmt " + struct.pack("<IHHIIHH", 16, 3, ch, sr, sr * ch * 4, ch * 4, 32))
    f.write(b"data" + struct.pack("<I", len(data)) + data)
print(f"decoded {src} -> {dst}: {sr} Hz, {ch} ch, {len(data) / 4 / ch / sr:.2f} s")
