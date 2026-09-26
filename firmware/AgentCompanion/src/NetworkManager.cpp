#include "NetworkManager.h"
#include "Config.h"
#include "DeviceCommands.h"

#include <Arduino.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <WiFiUdp.h>
#include <cstring>

namespace {
constexpr uint32_t kSetupDurationMs = 10 * 60 * 1000;
constexpr uint32_t kReconnectDelayMs = 15 * 1000;
constexpr char kDiscoveryRequest[] = "ESP32_AGENT_COMPANION_DISCOVER_V1";
constexpr char kPreferencesNamespace[] = "agent-network";

DNSServer dns;
WebServer server(80);
WiFiUDP discovery;

constexpr char kSetupPage[] = R"HTML(
<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Companion Wi-Fi</title><style>
body{font:16px system-ui;background:#10151d;color:#eef2f7;max-width:32rem;margin:3rem auto;padding:1rem}
form{display:grid;gap:1rem}input,button{font:inherit;padding:.8rem;border-radius:.5rem;border:1px solid #667}
button{background:#087f74;color:white;font-weight:700}small{color:#b8c0cc}
</style></head><body><h1>Agent Companion Wi-Fi</h1>
<p>Enter the 2.4 GHz Wi-Fi network this companion should use.</p>
<form method="post" action="/configure"><label>Network name<input name="ssid" maxlength="32" required></label>
<label>Password<input name="password" type="password" maxlength="63"></label>
<button type="submit">Connect</button></form>
<p><small>Credentials stay on this device. After it connects, return your computer to the same network and run the pairing command shown in the project README.</small></p>
</body></html>)HTML";

bool elapsed(uint32_t now, uint32_t deadline) {
  return deadline && static_cast<int32_t>(now - deadline) >= 0;
}

void copyText(char* destination, size_t capacity, const String& source) {
  std::strncpy(destination, source.c_str(), capacity - 1);
  destination[capacity - 1] = '\0';
}
}

namespace copilot {
void NetworkManager::begin(CommandHandler commandHandler, const CharacterUpload* upload,
                           BadgeHandler badgeHandler) {
  commandHandler_ = commandHandler;
  upload_ = upload;
  badgeHandler_ = badgeHandler;
  bootId_ = esp_random();
  ensureIdentity();
  Preferences preferences;
  if (preferences.begin(kPreferencesNamespace, true)) {
    copyText(ssid_, sizeof(ssid_), preferences.getString("ssid"));
    copyText(password_, sizeof(password_), preferences.getString("password"));
    preferences.end();
  }
  configured_ = ssid_[0] != '\0';
  configureRoutes();
  if (configured_) connect();
}

void NetworkManager::ensureIdentity() {
  const uint64_t mac = ESP.getEfuseMac();
  snprintf(deviceId_, sizeof(deviceId_), "%08x%08x",
           static_cast<unsigned>(mac >> 32), static_cast<unsigned>(mac));
  snprintf(hostname_, sizeof(hostname_), "agent-companion-%08x",
           static_cast<unsigned>(mac));
  Preferences preferences;
  if (preferences.begin(kPreferencesNamespace, false)) {
    String saved = preferences.getString("token");
    if (saved.length() == 32) {
      copyText(token_, sizeof(token_), saved);
      identityReady_ = true;
    } else {
      for (unsigned i = 0; i < 16; ++i)
        snprintf(token_ + i * 2, 3, "%02x", static_cast<unsigned>(esp_random() & 0xff));
      identityReady_ = preferences.putString("token", token_) == std::strlen(token_);
    }
    preferences.end();
  }
}

void NetworkManager::configureRoutes() {
  const char* headers[] = {"Authorization"};
  server.collectHeaders(headers, 1);
  server.on("/", HTTP_GET, [] { server.send(200, "text/html", kSetupPage); });
  server.on("/configure", HTTP_POST, [this] { handleConfigure(); });
  server.on("/pair", HTTP_POST, [this] { handlePair(); });
  server.on("/state", HTTP_POST, [this] { handleState(); });
  server.on("/icon", HTTP_POST, [this] { handleIcon(); });
  server.on("/agents", HTTP_POST, [this] { handleAgents(); });
  server.on("/character", HTTP_POST, [this] { handleCharacterResponse(); },
            [this] { handleCharacterBody(); });
  server.on("/status", HTTP_GET, [this] {
    if (!authorized()) {
      server.send(401, "application/json", "{\"error\":\"Unauthorized\"}");
      return;
    }
    char response[224];
    snprintf(response, sizeof(response),
             "{\"deviceId\":\"%s\",\"hostname\":\"%s\",\"connected\":%s,\"boot\":%u,\"protocol\":%u,"
             "\"character\":\"%s\"}",
             deviceId_, hostname_, connected_ ? "true" : "false",
             static_cast<unsigned>(bootId_), static_cast<unsigned>(kDeviceProtocol),
             upload_ ? upload_->installedId() : "none");
    server.send(200, "application/json", response);
  });
  server.onNotFound([] {
    server.sendHeader("Location", "/", true);
    server.send(302, "text/plain", "");
  });
}

void NetworkManager::connect() {
  WiFi.mode(setupActive_ ? WIFI_AP_STA : WIFI_STA);
  WiFi.setHostname(hostname_);
  WiFi.begin(ssid_, password_);
  reconnectAt_ = millis() + kReconnectDelayMs;
}

bool NetworkManager::configure(const char* ssid, const char* password) {
  const size_t ssidLength = std::strlen(ssid);
  const size_t passwordLength = std::strlen(password);
  if (!identityReady_ || ssidLength == 0 || ssidLength > 32 || passwordLength > 63
      || (passwordLength > 0 && passwordLength < 8)) return false;
  Preferences preferences;
  if (!preferences.begin(kPreferencesNamespace, false)) return false;
  const bool saved = preferences.putString("ssid", ssid) == ssidLength
      && preferences.putString("password", password) == passwordLength;
  preferences.end();
  if (!saved) return false;
  copyText(ssid_, sizeof(ssid_), ssid);
  copyText(password_, sizeof(password_), password);
  configured_ = true;
  connected_ = false;
  setChanged();
  connect();
  return true;
}

bool NetworkManager::startSetup() {
  ensureIdentity();
  if (!identityReady_) return false;
  const unsigned code = 10000000u + esp_random() % 90000000u;
  snprintf(pairingCode_, sizeof(pairingCode_), "%08u", code);
  snprintf(setupName_, sizeof(setupName_), "Agent-Companion-%04X",
           static_cast<unsigned>(ESP.getEfuseMac()) & 0xffff);
  WiFi.mode(WIFI_AP_STA);
  if (!WiFi.softAP(setupName_, pairingCode_)) return false;
  dns.start(53, "*", WiFi.softAPIP());
  if (!serverStarted_) {
    server.begin();
    serverStarted_ = true;
  }
  if (!discoveryStarted_) {
    discovery.begin(kNetworkDiscoveryPort);
    discoveryStarted_ = true;
  }
  setupActive_ = true;
  setupDeadline_ = millis() + kSetupDurationMs;
  stopSetupAt_ = 0;
  setChanged();
  return true;
}

void NetworkManager::handleConfigure() {
  if (!setupClient()) {
    server.send(403, "text/plain", "Wi-Fi setup is not active on this connection.");
    return;
  }
  const String requestedSsid = server.arg("ssid");
  const String requestedPassword = server.arg("password");
  if (requestedSsid.isEmpty() || requestedSsid.length() > 32
      || requestedPassword.length() > 63
      || (!requestedPassword.isEmpty() && requestedPassword.length() < 8)) {
    server.send(400, "text/plain", "Invalid Wi-Fi network name or password.");
    return;
  }
  if (!configure(requestedSsid.c_str(), requestedPassword.c_str())) {
    server.send(500, "text/plain", "Could not save Wi-Fi credentials.");
    return;
  }
  server.send(200, "text/html",
      "<!doctype html><meta name=\"viewport\" content=\"width=device-width\"><h1>Connecting</h1>"
      "<p>Return this computer to the configured Wi-Fi network. Keep the pairing code shown "
      "on the companion, then run <code>npm run pair CODE</code>.</p>");
}

void NetworkManager::handlePair() {
  if (!setupActive_ || elapsed(millis(), setupDeadline_)
      || server.arg("plain") != pairingCode_) {
    server.send(403, "application/json", "{\"error\":\"Invalid or expired pairing code\"}");
    return;
  }
  char response[96];
  snprintf(response, sizeof(response), "{\"deviceId\":\"%s\",\"token\":\"%s\"}",
           deviceId_, token_);
  server.send(200, "application/json", response);
  stopSetupAt_ = millis() + 1000;
}

bool NetworkManager::authorized() const {
  const String header = server.header("Authorization");
  return header.length() == 7 + std::strlen(token_)
      && header.startsWith("Bearer ")
      && header.substring(7) == token_;
}

bool NetworkManager::setupClient() const {
  if (!setupActive_) return false;
  const IPAddress remote = server.client().remoteIP();
  const IPAddress local = WiFi.softAPIP();
  return remote[0] == local[0] && remote[1] == local[1] && remote[2] == local[2];
}

void NetworkManager::handleState() {
  if (!authorized()) {
    server.send(401, "application/json", "{\"error\":\"Unauthorized\"}");
    return;
  }
  const String state = server.arg("plain");
  if (!commandHandler_ || !commandHandler_(state.c_str())) {
    server.send(400, "application/json", "{\"error\":\"Invalid state\"}");
    return;
  }
  server.send(200, "application/json", "{\"ok\":true}");
}

void NetworkManager::handleIcon() {
  if (!authorized()) {
    server.send(401, "application/json", "{\"error\":\"Unauthorized\"}");
    return;
  }
  char response[96];
  String body = server.arg("plain");
  body.trim();
  if (!badgeHandler_ || !badgeHandler_(body.c_str(), response, sizeof(response))) {
    char error[144];
    snprintf(error, sizeof(error), "{\"error\":\"%s\"}", response[0] ? response : "Invalid icon");
    server.send(400, "application/json", error);
    return;
  }
  char json[144];
  snprintf(json, sizeof(json), "{\"ok\":true,\"message\":\"%s\"}", response);
  server.send(200, "application/json", json);
}

void NetworkManager::handleAgents() {
  if (!authorized()) {
    server.send(401, "application/json", "{\"error\":\"Unauthorized\"}");
    return;
  }
  char response[96];
  String body = server.arg("plain");
  body.trim();
  if (!badgeHandler_ || !badgeHandler_(body.c_str(), response, sizeof(response))) {
    char error[144];
    snprintf(error, sizeof(error), "{\"error\":\"%s\"}", response[0] ? response : "Invalid agents");
    server.send(400, "application/json", error);
    return;
  }
  char json[144];
  snprintf(json, sizeof(json), "{\"ok\":true,\"message\":\"%s\"}", response);
  server.send(200, "application/json", json);
}

void NetworkManager::handleCharacterBody() {
  HTTPRaw& raw = server.raw();
  if (raw.status == RAW_START) {
    uploadAuthorized_ = authorized();
    uploadStarted_ = false;
    uploadError_ = nullptr;
    if (!uploadAuthorized_ || !upload_) return;
    uploadStarted_ = true;
    uploadError_ = upload_->begin();
    return;
  }
  if (!uploadStarted_) return;
  if (raw.status == RAW_WRITE) {
    if (!uploadError_) uploadError_ = upload_->write(raw.buf, raw.currentSize);
  } else if (raw.status == RAW_END) {
    if (!uploadError_) uploadError_ = upload_->finish();
    else upload_->abort(uploadError_);
  } else if (raw.status == RAW_ABORTED) {
    uploadError_ = "Character upload was interrupted.";
    upload_->abort(uploadError_);
    uploadStarted_ = false;
  }
}

void NetworkManager::handleCharacterResponse() {
  const bool authorizedUpload = uploadAuthorized_;
  uploadAuthorized_ = false;
  if (!authorizedUpload) {
    server.send(401, "application/json", "{\"error\":\"Unauthorized\"}");
    return;
  }
  if (!uploadStarted_) {
    server.send(400, "application/json", "{\"error\":\"Missing character pack body\"}");
    return;
  }
  uploadStarted_ = false;
  char response[160];
  if (uploadError_) {
    snprintf(response, sizeof(response), "{\"ok\":false,\"error\":\"%s\"}", uploadError_);
    server.send(400, "application/json", response);
    return;
  }
  snprintf(response, sizeof(response), "{\"ok\":true,\"character\":\"%s\"}",
           upload_->installedId());
  server.send(200, "application/json", response);
}

void NetworkManager::handleDiscovery() {
  const int bytes = discovery.parsePacket();
  if (bytes <= 0 || bytes >= 64) return;
  char request[64] = {};
  const int read = discovery.read(request, sizeof(request) - 1);
  if (read <= 0 || std::strcmp(request, kDiscoveryRequest) != 0 || !connected_) return;
  char response[192];
  snprintf(response, sizeof(response),
           "{\"service\":\"esp32-agent-companion\",\"protocol\":1,\"deviceId\":\"%s\","
           "\"hostname\":\"%s\",\"ip\":\"%s\",\"port\":80,\"boot\":%u}",
           deviceId_, hostname_, address_, static_cast<unsigned>(bootId_));
  discovery.beginPacket(discovery.remoteIP(), discovery.remotePort());
  discovery.write(reinterpret_cast<const uint8_t*>(response), std::strlen(response));
  discovery.endPacket();
}

void NetworkManager::updateConnection() {
  const bool nowConnected = WiFi.status() == WL_CONNECTED;
  if (nowConnected != connected_) {
    connected_ = nowConnected;
    if (connected_) {
      copyText(address_, sizeof(address_), WiFi.localIP().toString());
      MDNS.end();
      if (MDNS.begin(hostname_)) {
        MDNS.addService("agent-companion", "tcp", 80);
        MDNS.addServiceTxt("agent-companion", "tcp", "id",
                           static_cast<const char*>(deviceId_));
        MDNS.addServiceTxt("agent-companion", "tcp", "protocol", "1");
      }
      if (!serverStarted_) {
        server.begin();
        serverStarted_ = true;
      }
      if (!discoveryStarted_) {
        discovery.begin(kNetworkDiscoveryPort);
        discoveryStarted_ = true;
      }
    } else {
      address_[0] = '\0';
      MDNS.end();
    }
    setChanged();
  }
  if (configured_ && !nowConnected && elapsed(millis(), reconnectAt_)) connect();
}

void NetworkManager::stopSetup() {
  dns.stop();
  WiFi.softAPdisconnect(true);
  setupActive_ = false;
  pairingCode_[0] = '\0';
  setupName_[0] = '\0';
  setupDeadline_ = 0;
  stopSetupAt_ = 0;
  WiFi.mode(configured_ ? WIFI_STA : WIFI_OFF);
  setChanged();
}

void NetworkManager::update() {
  updateConnection();
  if (serverStarted_) server.handleClient();
  if (setupActive_) {
    dns.processNextRequest();
    const uint32_t now = millis();
    if (elapsed(now, setupDeadline_) || elapsed(now, stopSetupAt_)) stopSetup();
  }
  if (discoveryStarted_) handleDiscovery();
}

void NetworkManager::setChanged() {
  ++revision_;
}
}
