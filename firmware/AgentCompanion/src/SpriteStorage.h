#pragma once
#include "CharacterPack.h"
#include <cstddef>
#include <cstdint>

namespace copilot {
// Maps and verifies the single installed pack. False means the shell has no character.
bool initializeSpriteStorage();
const char* spriteStorageError();
const CharacterPack* characterPack();
// Returns the compressed bytes for a block of the installed pack, or nullptr.
const uint8_t* spriteBlock(const SpriteBlock& block);
// Host builds select a pack already in memory; the packer verified its SHA-256.
bool loadCharacterPack(const uint8_t* bytes, size_t size);

// Device installation. Callers must stop reading the current pack before beginning.
const char* beginCharacterInstall();
const char* writeCharacterInstall(const uint8_t* data, size_t bytes);
const char* finishCharacterInstall();
void abortCharacterInstall();
uint32_t characterInstallReceived();
uint32_t characterInstallTotal();
// Display name from the incoming pack header, or nullptr until the header arrives.
const char* characterInstallName();
size_t characterPartitionBytes();
}
