package main

import "testing"

func TestPublicIP(t *testing.T) {
	for _, address := range []string{"104.26.8.23", "172.67.73.67", "2606:4700::1111"} {
		if !publicIP(address) {
			t.Errorf("rejected public address %s", address)
		}
	}
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "192.168.1.1", "100.64.0.1", "198.18.0.1", "192.0.2.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2606:4700::1111%lo0", "not-an-IP"} {
		if publicIP(address) {
			t.Errorf("accepted non-public address %s", address)
		}
	}
}

func TestValidate(t *testing.T) {
	base := request{URL: "https://api.bgm.tv/v0/search/subjects", Method: "POST", Addresses: []string{"104.26.8.23"}, ECHConfig: []byte{1, 2, 3, 4}, TimeoutMs: 20000}
	if _, err := validate(base); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"http://api.bgm.tv/", "https://api.bgm.tv:444/", "https://evil.example/", "https://api.bgm.tv.evil.example/", "https://user:pass@api.bgm.tv/", "https://api.bgm.tv/#fragment"} {
		input := base
		input.URL = target
		if _, err := validate(input); err == nil {
			t.Errorf("accepted invalid target %s", target)
		}
	}
	input := base
	input.Addresses = []string{"104.26.8.23", "127.0.0.1"}
	if _, err := validate(input); err == nil {
		t.Error("accepted mixed public/private addresses")
	}
	input = base
	input.ECHConfig = nil
	if _, err := validate(input); err == nil {
		t.Error("accepted missing ECH config")
	}
	input = base
	input.Body = make([]byte, (1<<20)+1)
	if _, err := validate(input); err == nil {
		t.Error("accepted oversized body")
	}
}
