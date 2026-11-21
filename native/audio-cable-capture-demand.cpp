#include <windows.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <initguid.h>
#include <functiondiscoverykeys_devpkey.h>
#include <wrl/client.h>

#include <cstdio>
#include <cwchar>
#include <optional>
#include <string>

namespace {
using Microsoft::WRL::ComPtr;
constexpr wchar_t defaultCable[] = L"CABLE Input (VB-Audio Virtual Cable)";

std::optional<std::wstring> property(IMMDevice* device, const PROPERTYKEY& key) {
  ComPtr<IPropertyStore> store;
  if (FAILED(device->OpenPropertyStore(STGM_READ, &store))) return std::nullopt;
  PROPVARIANT value;
  PropVariantInit(&value);
  std::optional<std::wstring> result;
  if (SUCCEEDED(store->GetValue(key, &value)) && value.vt == VT_LPWSTR && value.pwszVal)
    result = value.pwszVal;
  PropVariantClear(&value);
  return result;
}

ComPtr<IMMDevice> uniqueEndpoint(IMMDeviceEnumerator* enumerator, EDataFlow flow,
                                 const PROPERTYKEY& key, const wchar_t* name) {
  ComPtr<IMMDeviceCollection> devices;
  UINT count = 0;
  if (FAILED(enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &devices)) ||
      FAILED(devices->GetCount(&count))) return {};
  ComPtr<IMMDevice> match;
  for (UINT i = 0; i < count; ++i) {
    ComPtr<IMMDevice> device;
    if (FAILED(devices->Item(i, &device))) return {};
    const auto value = property(device.Get(), key);
    if (!value) return {};
    if (_wcsicmp(value->c_str(), name) != 0) continue;
    if (match) return {};  // A duplicate name cannot identify the selected device.
    match = device;
  }
  return match;
}

bool isVbCable(const std::wstring& adapter) {
  for (const wchar_t* known : {L"VB-Audio Virtual Cable", L"VB-Audio Cable A", L"VB-Audio Cable B",
                               L"VB-Audio Cable C", L"VB-Audio Cable D"}) {
    if (_wcsicmp(adapter.c_str(), known) == 0) return true;
  }
  return false;
}

std::optional<bool> captureDemand(const wchar_t* renderLabel) {
  ComPtr<IMMDeviceEnumerator> devices;
  if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&devices))))
    return std::nullopt;
  const auto render = uniqueEndpoint(devices.Get(), eRender, PKEY_Device_FriendlyName, renderLabel);
  if (!render) return std::nullopt;
  const auto adapter = property(render.Get(), PKEY_DeviceInterface_FriendlyName);
  if (!adapter || !isVbCable(*adapter)) return std::nullopt;
  const auto capture = uniqueEndpoint(devices.Get(), eCapture, PKEY_DeviceInterface_FriendlyName, adapter->c_str());
  if (!capture) return std::nullopt;

  ComPtr<IAudioSessionManager2> manager;
  ComPtr<IAudioSessionEnumerator> sessions;
  int count = 0;
  if (FAILED(capture->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                               reinterpret_cast<void**>(manager.GetAddressOf()))) ||
      FAILED(manager->GetSessionEnumerator(&sessions)) || FAILED(sessions->GetCount(&count))) return std::nullopt;
  for (int i = 0; i < count; ++i) {
    ComPtr<IAudioSessionControl> session;
    AudioSessionState state;
    if (FAILED(sessions->GetSession(i, &session)) || FAILED(session->GetState(&state))) return std::nullopt;
    if (state == AudioSessionStateActive) return true;
  }
  return false;
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  const bool once = argc > 1 && std::wcscmp(argv[1], L"--once") == 0;
  const int labelIndex = once ? 2 : 1;
  const wchar_t* label = argc > labelIndex ? argv[labelIndex] : defaultCable;
  if (argc > labelIndex + 1 || FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) {
    std::puts("null");
    return 0;
  }

  const HANDLE parentPipe = GetStdHandle(STD_INPUT_HANDLE);
  std::optional<bool> previous;
  bool first = true;
  do {
    const auto demand = captureDemand(label);
    if (first || demand != previous) {
      std::puts(demand ? (*demand ? "true" : "false") : "null");
      std::fflush(stdout);
      previous = demand;
      first = false;
    }
    if (once) break;
    Sleep(250);
    // Electron owns the write end. Windows closes it even when Electron crashes.
  } while (PeekNamedPipe(parentPipe, nullptr, 0, nullptr, nullptr, nullptr));
  CoUninitialize();
  return 0;
}
