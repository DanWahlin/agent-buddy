#pragma once

#include <cstddef>

namespace copilot {
// The device asks Deepgram Flux TTS for a line itself, then plays it through the speaker.
enum class DeepgramRequest : unsigned char { Accepted, Busy, Unconfigured, Invalid, Unavailable };

// Loads the saved key and voice. Call once at startup.
void beginDeepgramSpeech();
// Saves the key and voice in flash; an empty key removes the key. Returns an error or nullptr.
const char* setDeepgramConfig(const char* key, const char* model);
bool deepgramConfigured();
// True from an accepted request until its line has finished playing or failed.
bool deepgramSpeaking();
// Why the last line failed, or nullptr. Cleared by the next accepted request.
const char* deepgramError();
// Starts fetching and playing one line on a background task without blocking the caller.
DeepgramRequest requestDeepgramSpeech(const char* text, size_t length);
}
