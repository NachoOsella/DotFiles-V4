#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import types
import unittest
from unittest.mock import patch

path = Path(__file__).resolve().parents[2] / "quickshell/.config/quickshell/scripts/iwd-client.py"
spec = importlib.util.spec_from_file_location("iwd_client", path)
iwd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(iwd)


class IwdClientTests(unittest.TestCase):
    def snapshot(self, powered=True):
        device = "/net/connman/iwd/0/3"
        network = device + "/example_psk"
        objects = {
            device: {
                iwd.DEVICE: {"Name": "wlan0", "Powered": powered},
                iwd.STATION: {"State": "connected" if powered else "disconnected", "ConnectedNetwork": network if powered else ""},
            },
            network: {iwd.NETWORK: {"Name": 'Wi-Fi "home" & café', "Type": "psk", "KnownNetwork": "/known", "Device": device}},
        }
        client = iwd.Client.__new__(iwd.Client)
        client.pending = False
        client.objects = lambda: objects
        client.interface = lambda *args: types.SimpleNamespace(GetOrderedNetworks=lambda: [(network, -6500)])
        with patch.object(iwd.Path, "iterdir", return_value=[]), patch.object(iwd.subprocess, "run", return_value=types.SimpleNamespace(stdout="[]")):
            return client.snapshot()

    def test_connected_network_preserves_name_and_normalizes_signal(self):
        status = self.snapshot()
        self.assertTrue(status["wifiConnected"])
        self.assertEqual(status["ssid"], 'Wi-Fi "home" & café')
        self.assertAlmostEqual(status["signalStrength"], 0.7)
        self.assertTrue(status["networks"][0]["known"])
        self.assertTrue(status["networks"][0]["connected"])

    def test_disabled_radio_is_available_without_stale_networks(self):
        status = self.snapshot(powered=False)
        self.assertTrue(status["wifiAvailable"])
        self.assertFalse(status["wifiEnabled"])
        self.assertFalse(status["wifiConnected"])
        self.assertEqual(status["networks"], [])

    def test_passphrase_is_only_returned_for_the_requested_network(self):
        agent = iwd.Agent.__new__(iwd.Agent)
        agent.network_path = "/selected"
        agent.password = "test-passphrase"
        self.assertEqual(agent.RequestPassphrase("/selected"), "test-passphrase")
        with self.assertRaises(iwd.Canceled):
            agent.RequestPassphrase("/other")
        agent.Cancel("canceled")
        with self.assertRaises(iwd.Canceled):
            agent.RequestPassphrase("/selected")


if __name__ == "__main__":
    unittest.main()
