package p2pserver

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"tailscale.com/derp/derpserver"
	"tailscale.com/net/stunserver"
	"tailscale.com/tailcfg"
	"tailscale.com/types/key"
)

// derpRegionID is the only DERP region devices know: the public Tailscale
// regions are left out of the map.
const derpRegionID tailcfg.DERPRegionID = 900

// DERPConfig configures the tailnet relay.
type DERPConfig struct {
	// PublicIP is the address devices dial; the certificate is issued for it.
	PublicIP net.IP
	// Listen is the TLS listen address for DERP, e.g. ":8443".
	Listen string
	// STUNListen is the UDP listen address for STUN, e.g. ":3478".
	STUNListen string
	// KeyPath and CertPath persist the relay's node key and its self-signed
	// certificate, so the pinned certificate hash survives restarts.
	KeyPath  string
	CertPath string
	// Admit decides whether a node key may use the relay.
	Admit  func(ctx context.Context, node key.NodePublic) (bool, error)
	Logger *slog.Logger
}

// DERP is a running tailnet relay and STUN server.
type DERP struct {
	server   *derpserver.Server
	https    *http.Server
	admit    *http.Server
	cancel   context.CancelFunc
	derpPort int
	stunPort int
	ip       net.IP
	certHash string
}

// StartDERP serves DERP over TLS with a self-signed certificate that the DERP
// map pins by hash, so no domain or CA is needed.
func StartDERP(cfg DERPConfig) (*DERP, error) {
	if cfg.PublicIP == nil {
		return nil, errors.New("p2pserver: DERP needs the public IP")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	nodeKey, err := loadOrCreateNodeKey(cfg.KeyPath)
	if err != nil {
		return nil, err
	}
	cert, err := loadOrCreateCert(cfg.CertPath, cfg.PublicIP)
	if err != nil {
		return nil, err
	}
	logf := func(format string, args ...any) { logger.Debug("derp: " + fmt.Sprintf(format, args...)) }
	s := derpserver.New(nodeKey, logf)

	// derpserver only calls out to an admission URL; serve it on loopback.
	admitLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		s.Close()
		return nil, err
	}
	admit := &http.Server{Handler: admitHandler(cfg.Admit, logger), ReadHeaderTimeout: 5 * time.Second}
	go admit.Serve(admitLn)
	s.SetVerifyClientURL("http://" + admitLn.Addr().String() + "/admit")
	s.SetVerifyClientURLFailOpen(false)

	ln, err := net.Listen("tcp", cfg.Listen)
	if err != nil {
		admit.Close()
		s.Close()
		return nil, fmt.Errorf("p2pserver: DERP listen: %w", err)
	}
	mux := http.NewServeMux()
	mux.Handle("/derp", derpserver.Handler(s))
	mux.HandleFunc("/derp/probe", derpserver.ProbeHandler)
	mux.HandleFunc("/derp/latency-check", derpserver.ProbeHandler)
	mux.HandleFunc("/generate_204", derpserver.ServeNoContent)
	https := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
	}
	go func() {
		if err := https.ServeTLS(ln, "", ""); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("p2pserver: DERP stopped", "error", err)
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	stun := stunserver.New(ctx)
	if err := stun.Listen(cfg.STUNListen); err != nil {
		cancel()
		https.Close()
		admit.Close()
		s.Close()
		return nil, fmt.Errorf("p2pserver: STUN listen: %w", err)
	}
	go stun.Serve()

	sum := sha256.Sum256(cert.Leaf.Raw)
	d := &DERP{
		server:   s,
		https:    https,
		admit:    admit,
		cancel:   cancel,
		derpPort: ln.Addr().(*net.TCPAddr).Port,
		stunPort: stun.LocalAddr().(*net.UDPAddr).Port,
		ip:       cfg.PublicIP,
		certHash: fmt.Sprintf("sha256-raw:%x", sum),
	}
	logger.Info("p2pserver: DERP listening", "addr", ln.Addr().String(), "stun", stun.LocalAddr().String())
	return d, nil
}

// Map is the DERP map the control server hands to nodes.
func (d *DERP) Map() *tailcfg.DERPMap {
	node := &tailcfg.DERPNode{
		Name:     strconv.FormatInt(int64(derpRegionID), 10) + "a",
		RegionID: derpRegionID,
		HostName: d.ip.String(),
		CertName: d.certHash,
		DERPPort: d.derpPort,
		STUNPort: d.stunPort,
	}
	if ip4 := d.ip.To4(); ip4 != nil {
		node.IPv4 = ip4.String()
	} else {
		node.IPv6 = d.ip.String()
	}
	return &tailcfg.DERPMap{
		OmitDefaultRegions: true,
		Regions: map[tailcfg.DERPRegionID]*tailcfg.DERPRegion{derpRegionID: {
			RegionID:   derpRegionID,
			RegionCode: "multica",
			RegionName: "Multica",
			Nodes:      []*tailcfg.DERPNode{node},
		}},
	}
}

func (d *DERP) Close() error {
	d.cancel()
	d.admit.Close()
	err := d.https.Close()
	d.server.Close()
	return err
}

func admitHandler(admit func(context.Context, key.NodePublic) (bool, error), logger *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req tailcfg.DERPAdmitClientRequest
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		allow := false
		if admit != nil {
			var err error
			if allow, err = admit(r.Context(), req.NodePublic); err != nil {
				logger.Warn("p2pserver: DERP admission check failed", "error", err)
				http.Error(w, "admission unavailable", http.StatusServiceUnavailable)
				return
			}
		}
		writeJSON(w, http.StatusOK, tailcfg.DERPAdmitClientResponse{Allow: allow})
	})
}

func loadOrCreateNodeKey(path string) (key.NodePrivate, error) {
	if raw, err := os.ReadFile(path); err == nil {
		var k key.NodePrivate
		if err := k.UnmarshalText(raw); err != nil {
			return key.NodePrivate{}, fmt.Errorf("p2pserver: DERP key %s: %w", path, err)
		}
		return k, nil
	} else if !os.IsNotExist(err) {
		return key.NodePrivate{}, err
	}
	k := key.NewNode()
	raw, err := k.MarshalText()
	if err != nil {
		return key.NodePrivate{}, err
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return key.NodePrivate{}, err
	}
	return k, nil
}

// loadOrCreateCert keeps one certificate per IP; a new public IP issues a new
// one, which the DERP map then pins.
func loadOrCreateCert(path string, ip net.IP) (tls.Certificate, error) {
	if raw, err := os.ReadFile(path); err == nil {
		cert, err := tls.X509KeyPair(raw, raw)
		if err == nil {
			if cert.Leaf, err = x509.ParseCertificate(cert.Certificate[0]); err == nil && cert.Leaf.VerifyHostname(ip.String()) == nil {
				return cert, nil
			}
		}
	} else if !os.IsNotExist(err) {
		return tls.Certificate{}, err
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: ip.String()},
		IPAddresses:  []net.IP{ip},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.AddDate(20, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(priv)
	if err != nil {
		return tls.Certificate{}, err
	}
	pemBytes := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})...)
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		return tls.Certificate{}, err
	}
	cert, err := tls.X509KeyPair(pemBytes, pemBytes)
	if err != nil {
		return tls.Certificate{}, err
	}
	cert.Leaf, err = x509.ParseCertificate(der)
	return cert, err
}
