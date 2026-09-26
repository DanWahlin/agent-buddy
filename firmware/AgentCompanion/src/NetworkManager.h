#pragma once

#include <cstddef>
#include <cstdint>

namespace copilot {
class NetworkManager {
 public:
  using CommandHandler = bool (*)(const char*);
  using BadgeHandler = bool (*)(const char* packet, char* response, size_t responseSize);
  // Streams an authenticated POST /character body into the device's pack installer.
  struct CharacterUpload {
    const char* (*begin)();
    const char* (*write)(const uint8_t* data, size_t bytes);
    const char* (*finish)();
    void (*abort)(const char* error);
    const char* (*installedId)();
  };

  void begin(CommandHandler commandHandler, const CharacterUpload* upload,
             BadgeHandler badgeHandler = nullptr);
  void update();
  bool startSetup();
  bool configure(const char* ssid, const char* password);

  bool configured() const { return configured_; }
  bool connected() const { return connected_; }
  bool setupActive() const { return setupActive_; }
  const char* ssid() const { return ssid_; }
  const char* address() const { return address_; }
  const char* setupName() const { return setupName_; }
  const char* pairingCode() const { return pairingCode_; }
  const char* deviceId() const { return deviceId_; }
  const char* token() const { return token_; }
  uint32_t revision() const { return revision_; }

 private:
  void configureRoutes();
  void connect();
  void handleConfigure();
  void handlePair();
  void handleState();
  void handleIcon();
  void handleAgents();
  void handleCharacterBody();
  void handleCharacterResponse();
  void handleDiscovery();
  void updateConnection();
  void stopSetup();
  void ensureIdentity();
  void setChanged();
  bool authorized() const;
  bool setupClient() const;

  CommandHandler commandHandler_ = nullptr;
  BadgeHandler badgeHandler_ = nullptr;
  const CharacterUpload* upload_ = nullptr;
  const char* uploadError_ = nullptr;
  bool uploadAuthorized_ = false;
  bool uploadStarted_ = false;
  char ssid_[33] = {};
  char password_[65] = {};
  char token_[33] = {};
  char deviceId_[17] = {};
  char hostname_[33] = {};
  char address_[16] = {};
  char setupName_[33] = {};
  char pairingCode_[9] = {};
  uint32_t bootId_ = 0;
  bool configured_ = false;
  bool connected_ = false;
  bool setupActive_ = false;
  bool serverStarted_ = false;
  bool discoveryStarted_ = false;
  bool identityReady_ = false;
  uint32_t setupDeadline_ = 0;
  uint32_t stopSetupAt_ = 0;
  uint32_t reconnectAt_ = 0;
  uint32_t revision_ = 0;
};
}
