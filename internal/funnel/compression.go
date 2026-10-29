package funnel

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/klauspost/compress/zstd"
)

const maxProviderBodyBytes = 16 << 20

// Bound both wire bytes and decoded JSON before inspecting model access.
func readProviderBody(c *gin.Context) ([]byte, int, error) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxProviderBodyBytes)
	raw, err := io.ReadAll(c.Request.Body)
	if err != nil {
		var sizeError *http.MaxBytesError
		if errors.As(err, &sizeError) {
			return nil, 413, err
		}
		return nil, 400, err
	}
	var reader io.Reader = bytes.NewReader(raw)
	switch strings.ToLower(strings.TrimSpace(c.Request.Header.Get("Content-Encoding"))) {
	case "", "identity":
		return raw, 0, nil
	case "gzip":
		decoder, err := gzip.NewReader(reader)
		if err != nil {
			return nil, 400, err
		}
		defer decoder.Close()
		reader = decoder
	case "zstd":
		decoder, err := zstd.NewReader(reader, zstd.WithDecoderConcurrency(1), zstd.WithDecoderMaxMemory(maxProviderBodyBytes))
		if err != nil {
			return nil, 400, err
		}
		defer decoder.Close()
		reader = decoder
	default:
		return nil, 415, fmt.Errorf("unsupported content encoding")
	}
	body, err := io.ReadAll(io.LimitReader(reader, maxProviderBodyBytes+1))
	if len(body) > maxProviderBodyBytes {
		return nil, 413, fmt.Errorf("decoded body too large")
	}
	if err != nil {
		return nil, 400, err
	}
	c.Request.Header.Del("Content-Encoding")
	c.Request.Header.Del("Content-Length")
	return body, 0, nil
}

// Wrap the SDK's selected transport, retaining its TLS identity and pools.
// Inspect only a replay copy; the live body remains untouched until replaced.
type claudeCompressionTransport struct{ next http.RoundTripper }

func (t claudeCompressionTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if r.Method != "POST" || r.URL.Scheme != "https" || r.URL.Hostname() != "api.anthropic.com" ||
		(r.URL.Path != "/v1/messages" && r.URL.Path != "/v1/messages/count_tokens") ||
		r.Header.Get("Content-Encoding") != "" || r.GetBody == nil || r.ContentLength < 4096 || r.ContentLength > maxProviderBodyBytes {
		return t.next.RoundTrip(r)
	}
	copyBody, err := r.GetBody()
	if err != nil {
		return nil, err
	}
	var compressed bytes.Buffer
	encoder, _ := gzip.NewWriterLevel(&compressed, gzip.BestSpeed)
	_, err = io.Copy(encoder, io.LimitReader(copyBody, maxProviderBodyBytes+1))
	_ = copyBody.Close()
	closeErr := encoder.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if int64(compressed.Len()) >= r.ContentLength {
		return t.next.RoundTrip(r)
	}
	wire := compressed.Bytes()
	request := r.Clone(r.Context())
	request.Body = io.NopCloser(bytes.NewReader(wire))
	request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(wire)), nil }
	request.ContentLength = int64(len(wire))
	request.Header.Del("Content-Length")
	request.Header.Set("Content-Encoding", "gzip")
	if r.Body != nil {
		_ = r.Body.Close()
	}
	return t.next.RoundTrip(request)
}
