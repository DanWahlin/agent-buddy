from hashlib import sha256
from pathlib import Path
import subprocess
import unittest
import wave

ROOT = Path(__file__).resolve().parents[1]
CUES = ("working", "needs-attention", "complete", "surprise", "settings-tick")


class AudioAssetTests(unittest.TestCase):
    def test_approved_cues_and_generated_firmware_are_current(self):
        for name in CUES:
            path = ROOT / "assets" / "audio" / f"{name}.wav"
            with wave.open(str(path), "rb") as wav:
                self.assertEqual(wav.getnchannels(), 1)
                self.assertEqual(wav.getsampwidth(), 2)
                self.assertEqual(wav.getframerate(), 24000)
                self.assertEqual(wav.getcomptype(), "NONE")
                self.assertGreater(wav.getnframes(), 0)
                self.assertLess(wav.getnframes(), 24000)
        tracked = (
            ROOT / "firmware" / "AgentCompanion" / "generated" / "audio_assets.h",
            ROOT / "firmware" / "AgentCompanion" / "src" / "audio_data.cpp",
        )
        before = [sha256(path.read_bytes()).digest() for path in tracked]
        subprocess.run(["python3", str(ROOT / "tools" / "embed_audio.py")], check=True)
        self.assertEqual(before, [sha256(path.read_bytes()).digest() for path in tracked])

    def test_embedded_metadata_matches_wav_files(self):
        header = (ROOT / "firmware" / "AgentCompanion" / "generated" / "audio_assets.h").read_text()
        names = {
            "working": "Working",
            "needs-attention": "Attention",
            "complete": "Complete",
            "surprise": "Surprise",
            "settings-tick": "Settings",
        }
        for filename, symbol in names.items():
            path = ROOT / "assets" / "audio" / f"{filename}.wav"
            with wave.open(str(path), "rb") as wav:
                frames = wav.getnframes()
            self.assertIn(f"kAudio{symbol}Samples = {frames};", header)
            self.assertIn(
                f'kAudio{symbol}Sha256 = "{sha256(path.read_bytes()).hexdigest()}";',
                header,
            )


if __name__ == "__main__":
    unittest.main()
