#!/usr/bin/env python3
"""Share iwd's D-Bus interface between Quickshell and the Rofi Wi-Fi menu."""

import json
import os
from pathlib import Path
import subprocess
import sys

import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

SERVICE = "net.connman.iwd"
DEVICE = SERVICE + ".Device"
STATION = SERVICE + ".Station"
NETWORK = SERVICE + ".Network"
PROPERTIES = "org.freedesktop.DBus.Properties"


class Canceled(dbus.DBusException):
    _dbus_error_name = SERVICE + ".Agent.Error.Canceled"


class Agent(dbus.service.Object):
    def __init__(self, bus, network_path, password):
        self.path = "/dotfiles/iwd_agent"
        super().__init__(bus, self.path)
        self.network_path = network_path
        self.password = password

    @dbus.service.method(SERVICE + ".Agent", in_signature="o", out_signature="s")
    def RequestPassphrase(self, network):
        if str(network) != self.network_path or not self.password:
            raise Canceled("No passphrase supplied for this network")
        return self.password

    @dbus.service.method(SERVICE + ".Agent", in_signature="s", out_signature="")
    def Cancel(self, reason):
        self.password = ""

    @dbus.service.method(SERVICE + ".Agent", in_signature="", out_signature="")
    def Release(self):
        self.password = ""


class Client:
    def __init__(self, emit):
        DBusGMainLoop(set_as_default=True)
        self.bus = dbus.SystemBus()
        self.loop = GLib.MainLoop()
        self.emit = emit
        self.pending = False
        self.agent = None
        self.refresh_source = None
        self.buffer = b""
        self.exit_code = 0

    def interface(self, path, name):
        return dbus.Interface(self.bus.get_object(SERVICE, path), name)

    def objects(self):
        return self.interface("/", "org.freedesktop.DBus.ObjectManager").GetManagedObjects()

    def station(self, objects):
        stations = [(path, data) for path, data in objects.items() if STATION in data]
        stations.sort(key=lambda item: item[1][STATION].get("State") != "connected")
        if not stations:
            raise RuntimeError("No iwd Wi-Fi station is available")
        return stations[0]

    def snapshot(self):
        objects = self.objects()
        try:
            path, data = self.station(objects)
        except RuntimeError:
            return {"wifiAvailable": False, "networks": []}
        device = data[DEVICE]
        station = data[STATION]
        connected_path = str(station.get("ConnectedNetwork", ""))
        interface = str(device["Name"])
        ordered = self.interface(path, STATION).GetOrderedNetworks() if device["Powered"] else []
        networks = []
        for network_path, strength in ordered:
            network = objects.get(network_path, {}).get(NETWORK)
            if not network:
                continue
            networks.append({
                "path": str(network_path),
                "name": str(network["Name"]),
                "type": str(network["Type"]),
                "known": "KnownNetwork" in network,
                "connected": str(network_path) == connected_path,
                # iwd reports hundredths of dBm; map -100..-50 dBm to 0..1.
                "signalStrength": max(0, min(1, (int(strength) / 100 + 100) / 50)),
                "stateChanging": self.pending,
            })
        active = objects.get(dbus.ObjectPath(connected_path), {}).get(NETWORK, {}) if connected_path else {}
        connected = str(station.get("State")) in ("connected", "roaming")
        wired = ""
        for entry in sorted(Path("/sys/class/net").iterdir()):
            try:
                if entry.name != "lo" and not (entry / "wireless").exists() and (entry / "device").exists() and (entry / "carrier").read_text().strip() == "1":
                    wired = entry.name
                    break
            except OSError:
                continue
        active_interface = wired or interface
        address = ""
        result = subprocess.run(["ip", "-j", "-4", "address", "show", "dev", active_interface], capture_output=True, text=True, check=False)
        for link in json.loads(result.stdout or "[]"):
            for info in link.get("addr_info", []):
                if info.get("scope") == "global":
                    address = info["local"]
                    break
        return {
            "wifiAvailable": True,
            "wifiEnabled": bool(device["Powered"]),
            "wifiConnected": connected,
            "wiredConnected": bool(wired),
            "interfaceName": active_interface,
            "address": address,
            "ssid": str(active.get("Name", "")),
            "signalStrength": next((network["signalStrength"] for network in networks if network["connected"]), 0),
            "networks": networks,
        }

    def publish(self):
        self.refresh_source = None
        try:
            self.emit({"status": self.snapshot()})
        except (dbus.DBusException, RuntimeError, OSError, ValueError) as error:
            self.exit_code = 1
            self.emit({"status": {"wifiAvailable": False, "networks": []}, "error": str(error)})
        return False

    def refresh(self, *args, **kwargs):
        if self.refresh_source is None:
            self.refresh_source = GLib.timeout_add(150, self.publish)

    def clear_agent(self):
        if self.agent is not None:
            self.agent.password = ""
            try:
                self.interface("/net/connman/iwd", SERVICE + ".AgentManager").UnregisterAgent(self.agent.path)
            except dbus.DBusException:
                pass
            self.agent.remove_from_connection()
            self.agent = None

    def request(self, command, finished=None):
        if self.pending:
            self.emit({"error": "A Wi-Fi operation is already in progress"})
            return

        def done(error=None):
            self.pending = False
            self.clear_agent()
            if error:
                self.exit_code = 1
                self.emit({"error": str(error)})
            self.refresh()
            if finished:
                finished()

        try:
            objects = self.objects()
            path, data = self.station(objects)
            action = command.get("action")
            self.pending = True
            if action == "connect":
                network_path = command.get("path", "")
                network = objects.get(dbus.ObjectPath(network_path), {}).get(NETWORK)
                if not network or network.get("Device") != path:
                    raise RuntimeError("The selected Wi-Fi network is no longer available")
                password = command.pop("password", "")
                if password:
                    self.agent = Agent(self.bus, network_path, password)
                    self.interface("/net/connman/iwd", SERVICE + ".AgentManager").RegisterAgent(self.agent.path)
                self.interface(network_path, NETWORK).Connect(reply_handler=done, error_handler=done, timeout=90)
            elif action == "disconnect":
                self.interface(path, STATION).Disconnect(reply_handler=done, error_handler=done)
            elif action == "scan":
                self.interface(path, STATION).Scan(reply_handler=done, error_handler=done)
            elif action == "toggle":
                self.interface(path, PROPERTIES).Set(DEVICE, "Powered", dbus.Boolean(not data[DEVICE]["Powered"]), reply_handler=done, error_handler=done)
            else:
                raise RuntimeError("Unknown Wi-Fi action")
            self.refresh()
        except (dbus.DBusException, RuntimeError, ValueError) as error:
            done(error)

    def read_commands(self, fd, condition):
        chunk = os.read(fd, 65536)
        if not chunk:
            self.loop.quit()
            return False
        self.buffer += chunk
        while b"\n" in self.buffer:
            line, self.buffer = self.buffer.split(b"\n", 1)
            try:
                self.request(json.loads(line))
            except (ValueError, TypeError, AttributeError):
                self.emit({"error": "Invalid Wi-Fi request"})
        return True

    def watch(self):
        for interface, signal in [(PROPERTIES, "PropertiesChanged"), ("org.freedesktop.DBus.ObjectManager", "InterfacesAdded"), ("org.freedesktop.DBus.ObjectManager", "InterfacesRemoved")]:
            self.bus.add_signal_receiver(self.refresh, signal_name=signal, dbus_interface=interface, bus_name=SERVICE)
        self.bus.add_signal_receiver(self.refresh, signal_name="NameOwnerChanged", dbus_interface="org.freedesktop.DBus", arg0=SERVICE)
        GLib.io_add_watch(sys.stdin.fileno(), GLib.IO_IN | GLib.IO_HUP, self.read_commands)
        self.publish()
        try:
            self.loop.run()
        finally:
            self.clear_agent()


def rofi_menu(client):
    theme = os.environ.get("ROFI_WIFI_THEME", str(Path.home() / ".config/rofi/wifi-menu.rasi"))

    def choose(prompt, text="", password=False):
        args = ["rofi", "-dmenu", "-i", "-p", prompt, "-theme", theme]
        args += ["-password"] if password else ["-format", "i", "-no-custom"]
        result = subprocess.run(args, input=text, capture_output=True, text=True, check=False)
        return result.stdout.rstrip("\n") if result.returncode == 0 else None

    status = client.snapshot()
    if not status.get("wifiAvailable"):
        raise RuntimeError("No iwd Wi-Fi station is available")
    networks = status["networks"]
    labels = ["Disable Wi-Fi" if status["wifiEnabled"] else "Enable Wi-Fi", "Scan", "Disconnect"]
    for network in networks:
        suffix = " [connected]" if network["connected"] else " [saved]" if network["known"] else ""
        labels.append(network["name"].replace("\n", " ") + suffix)
    selected = choose("Wi-Fi", "\n".join(labels))
    if selected is None:
        return
    index = int(selected)
    if index < 3:
        command = {"action": ["toggle", "scan", "disconnect"][index]}
    else:
        network = networks[index - 3]
        command = {"action": "disconnect" if network["connected"] else "connect", "path": network["path"]}
        if not network["connected"] and not network["known"] and network["type"] != "open":
            if network["type"] != "psk":
                raise RuntimeError("Configure this enterprise network with iwctl first")
            password = choose("Password", password=True)
            if password is None:
                return
            command["password"] = password
    client.request(command, client.loop.quit)
    if client.pending:
        client.loop.run()


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    errors = []

    def emit(message):
        if action in ("watch", "status"):
            print(json.dumps(message, ensure_ascii=True), flush=True)
        elif "error" in message:
            errors.append(message["error"])

    client = Client(emit)
    try:
        if action == "watch":
            client.watch()
        elif action == "status":
            client.publish()
        elif action == "menu":
            rofi_menu(client)
        else:
            command = {"action": action}
            if action == "connect":
                command.update(path=sys.argv[2], password=sys.stdin.readline().rstrip("\n"))
            client.request(command, client.loop.quit)
            if client.pending:
                client.loop.run()
    except (dbus.DBusException, RuntimeError, ValueError, IndexError, OSError) as error:
        errors.append(str(error))
    finally:
        client.clear_agent()
    if errors:
        message = "\n".join(errors)
        if action == "menu":
            subprocess.run(["notify-send", "Wi-Fi", message], check=False)
        else:
            print(message, file=sys.stderr)
    return 1 if errors else client.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
