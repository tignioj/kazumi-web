// kazumi-ech performs one bounded, pinned HTTPS request over an accepted ECH
// connection. Redirects stay in Node so its URL and header policies still apply.
package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/netip"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

const maxBody = 8 << 20

type request struct {
	URL       string            `json:"url"`
	Method    string            `json:"method"`
	Headers   map[string]string `json:"headers"`
	Body      []byte            `json:"body"`
	Addresses []string          `json:"addresses"`
	ECHConfig []byte            `json:"echConfig"`
	TimeoutMs int               `json:"timeoutMs"`
}

type result struct {
	Status      int                 `json:"status,omitempty"`
	Headers     map[string][]string `json:"headers,omitempty"`
	Body        []byte              `json:"body,omitempty"`
	ECHAccepted bool                `json:"echAccepted,omitempty"`
	Error       string              `json:"error,omitempty"`
}

var reserved = []string{
	"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24",
	"192.88.99.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
	"240.0.0.0/4", "::/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64",
	"2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20",
}

func publicIP(value string) bool {
	ip, err := netip.ParseAddr(value)
	if err != nil || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, value := range reserved {
		if netip.MustParsePrefix(value).Contains(ip) {
			return false
		}
	}
	return true
}

func validate(input request) (*url.URL, error) {
	target, err := url.Parse(input.URL)
	if err != nil {
		return nil, errors.New("invalid URL")
	}
	host := target.Hostname()
	if target.Scheme != "https" || target.User != nil || target.Fragment != "" ||
		(target.Port() != "" && target.Port() != "443") ||
		(host != "api.bgm.tv" && host != "next.bgm.tv" && host != "lain.bgm.tv") {
		return nil, errors.New("ECH only supports HTTPS on the allowed Bangumi hosts")
	}
	if len(input.ECHConfig) == 0 || len(input.ECHConfig) > 65536 {
		return nil, errors.New("missing or oversized ECH config")
	}
	if len(input.Addresses) == 0 || len(input.Addresses) > 16 {
		return nil, errors.New("missing or excessive pinned addresses")
	}
	for _, address := range input.Addresses {
		if !publicIP(address) {
			return nil, errors.New("non-public pinned address")
		}
	}
	if len(input.Body) > 1<<20 || input.TimeoutMs <= 0 || input.TimeoutMs > 60000 {
		return nil, errors.New("invalid request limits")
	}
	return target, nil
}

func perform(input request) (result, error) {
	target, err := validate(input)
	if err != nil {
		return result{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(input.TimeoutMs)*time.Millisecond)
	defer cancel()
	config := input.ECHConfig
	// Go validates the outer certificate before returning authenticated retry
	// configs. Never retry without ECH or disable certificate verification.
	for attempt := 0; attempt < 2; attempt++ {
		var accepted atomic.Bool
		transport := &http.Transport{
			Proxy: nil,
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				var last error
				for _, ip := range input.Addresses {
					connection, err := (&net.Dialer{Timeout: 3 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(ip, "443"))
					if err == nil {
						return connection, nil
					}
					last = err
				}
				return nil, last
			},
			TLSClientConfig: &tls.Config{
				ServerName: target.Hostname(), MinVersion: tls.VersionTLS13,
				EncryptedClientHelloConfigList: config,
			},
			TLSHandshakeTimeout:    8 * time.Second,
			MaxResponseHeaderBytes: 65536,
			ForceAttemptHTTP2:      true,
			DisableKeepAlives:      true,
		}
		client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		req, err := http.NewRequestWithContext(ctx, input.Method, target.String(), bytes.NewReader(input.Body))
		if err != nil {
			return result{}, err
		}
		for key, value := range input.Headers {
			if strings.ContainsAny(key+value, "\r\n") {
				return result{}, errors.New("invalid header")
			}
			req.Header.Set(key, value)
		}
		req = req.WithContext(httptrace.WithClientTrace(req.Context(), &httptrace.ClientTrace{
			TLSHandshakeDone: func(state tls.ConnectionState, err error) {
				accepted.Store(err == nil && state.ECHAccepted)
				if accepted.Load() {
					fmt.Fprintln(os.Stderr, "ECH_ACCEPTED")
				}
			},
		}))
		resp, err := client.Do(req)
		transport.CloseIdleConnections()
		if err != nil {
			var rejected *tls.ECHRejectionError
			if attempt == 0 && errors.As(err, &rejected) && len(rejected.RetryConfigList) > 0 {
				config = rejected.RetryConfigList
				continue
			}
			return result{ECHAccepted: accepted.Load()}, err
		}
		defer resp.Body.Close()
		if resp.TLS == nil || !resp.TLS.ECHAccepted {
			return result{}, errors.New("server did not accept ECH")
		}
		body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
		if err != nil {
			return result{ECHAccepted: true}, err
		}
		if len(body) > maxBody {
			return result{ECHAccepted: true}, errors.New("response exceeds 8 MiB")
		}
		return result{Status: resp.StatusCode, Headers: resp.Header, Body: body, ECHAccepted: true}, nil
	}
	return result{}, errors.New("ECH retry limit exceeded")
}

func main() {
	var input request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 2<<20))
	err := decoder.Decode(&input)
	var output result
	if err == nil {
		output, err = perform(input)
	}
	if err != nil {
		output.Error = fmt.Sprint(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(output); err != nil {
		os.Exit(1)
	}
}
