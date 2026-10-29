package funnel

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestClaudeUpstreamCompressionKeepsTransportAndReplay(t *testing.T) {
	body := `{"model":"claude-sonnet-5-5","messages":[{"role":"user","content":"` + strings.Repeat("context ", 1024) + `"}]}`
	r, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer fixture")
	response := &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("stream"))}
	called := 0
	transport := claudeCompressionTransport{next: roundTripFunc(func(wire *http.Request) (*http.Response, error) {
		called++
		if wire.Header.Get("Content-Encoding") != "gzip" || wire.Header.Get("Authorization") != "Bearer fixture" || wire.ContentLength >= r.ContentLength {
			t.Fatal("upstream headers or compression were lost")
		}
		for i := range 2 {
			reader := wire.Body
			if i > 0 {
				reader, _ = wire.GetBody()
			}
			decoder, err := gzip.NewReader(reader)
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := io.ReadAll(decoder)
			_ = decoder.Close()
			if err != nil || string(decoded) != body {
				t.Fatal("compressed request or retry changed", err)
			}
		}
		return response, nil
	})}
	got, err := transport.RoundTrip(r)
	if err != nil || got != response || called != 1 || r.Header.Get("Content-Encoding") != "" {
		t.Fatal("selected transport or original request changed", err)
	}
}

func TestCompressedInputRejectsInvalidAndExpandedBodies(t *testing.T) {
	var oversized bytes.Buffer
	encoder := gzip.NewWriter(&oversized)
	_, _ = io.CopyN(encoder, strings.NewReader(strings.Repeat("x", maxProviderBodyBytes+1)), maxProviderBodyBytes+1)
	_ = encoder.Close()
	for _, test := range []struct {
		encoding string
		body     []byte
		want     int
	}{
		{"gzip", []byte("not gzip"), 400},
		{"zstd", []byte("not zstd"), 400},
		{"br", []byte("unknown encoding"), 415},
		{"gzip", oversized.Bytes(), 413},
	} {
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/", bytes.NewReader(test.body))
		c.Request.Header.Set("Content-Encoding", test.encoding)
		_, status, err := readProviderBody(c)
		if status != test.want || err == nil {
			t.Fatalf("%s: %d, %v", test.encoding, status, err)
		}
	}
}
