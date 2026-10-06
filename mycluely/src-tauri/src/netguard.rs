//! Outbound request guard for Vela's web tools (SSRF protection).
//!
//! Every URL the model asks for is parsed, resolved and checked here. Requests are pinned to
//! the addresses that were validated (no DNS-rebinding window) and redirects are followed
//! manually so every hop is validated again.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

pub const MAX_REDIRECTS: usize = 5;
const MAX_URL_LEN: usize = 2048;

fn v4_blocked(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (64..128).contains(&o[1]))
        || (o[0] == 192 && o[1] == 0 && o[2] == 0)
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && (o[1] == 18 || o[1] == 19))
        || (o[0] == 198 && o[1] == 51 && o[2] == 100)
        || (o[0] == 203 && o[1] == 0 && o[2] == 113)
        || o[0] >= 240
}

fn v6_blocked(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_blocked(v4);
    }
    let s = ip.segments();
    // IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address.
    let embedded = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if s[..6].iter().all(|x| *x == 0) {
        return ip.is_loopback() || ip.is_unspecified() || v4_blocked(embedded(s[6], s[7]));
    }
    if s[0] == 0x0064 && s[1] == 0xff9b && s[2..6].iter().all(|x| *x == 0) {
        return v4_blocked(embedded(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return v4_blocked(embedded(s[1], s[2]));
    }
    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        || (s[0] & 0xfe00) == 0xfc00 // unique local
        || (s[0] & 0xffc0) == 0xfe80 // link-local
        || (s[0] & 0xffc0) == 0xfec0 // deprecated site-local
        || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
}

pub fn ip_is_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_blocked(v4),
        IpAddr::V6(v6) => v6_blocked(v6),
    }
}

pub fn hostname_is_blocked(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || !host.contains('.') {
        return true; // single-label names resolve to intranet hosts
    }
    const SUFFIXES: [&str; 8] = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".intranet", ".corp"];
    host == "localhost" || SUFFIXES.iter().any(|s| host.ends_with(s))
}

/// Parses and validates a URL the model supplied. Does not touch the network.
pub fn validate_url(input: &str) -> Result<reqwest::Url, String> {
    let input = input.trim();
    if input.is_empty() || input.len() > MAX_URL_LEN {
        return Err("That doesn't look like a valid URL.".to_string());
    }
    let url = reqwest::Url::parse(input).map_err(|_| "That doesn't look like a valid URL.".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("Only http and https addresses can be opened.".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Addresses with embedded credentials aren't allowed.".to_string());
    }
    match url.host() {
        None => Err("That address has no host.".to_string()),
        Some(url::Host::Ipv4(ip)) if v4_blocked(ip) => Err(blocked_message()),
        Some(url::Host::Ipv6(ip)) if v6_blocked(ip) => Err(blocked_message()),
        Some(url::Host::Domain(d)) if hostname_is_blocked(d) => Err(blocked_message()),
        Some(_) => Ok(url),
    }
}

fn blocked_message() -> String {
    "That address points to a private or local network, so Vela won't open it.".to_string()
}

/// Resolves the host and rejects it if *any* resolved address is non-public.
pub async fn resolve_public(url: &reqwest::Url) -> Result<Vec<SocketAddr>, String> {
    let host = url.host_str().ok_or_else(|| "That address has no host.".to_string())?.to_string();
    let port = url.port_or_known_default().unwrap_or(443);
    let literal = host.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>().ok();
    let addrs: Vec<SocketAddr> = match literal {
        Some(ip) => vec![SocketAddr::new(ip, port)],
        None => tauri::async_runtime::spawn_blocking(move || {
            (host.as_str(), port).to_socket_addrs().map(|it| it.collect::<Vec<_>>())
        })
        .await
        .map_err(|_| "Couldn't look that address up.".to_string())?
        .map_err(|_| "Couldn't find that website.".to_string())?,
    };
    if addrs.is_empty() {
        return Err("Couldn't find that website.".to_string());
    }
    if addrs.iter().any(|a| ip_is_blocked(a.ip())) {
        return Err(blocked_message());
    }
    Ok(addrs)
}

/// Resolves a `Location` header against the current URL and validates the next hop.
pub fn next_hop(current: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let next = current.join(location).map_err(|_| "The site sent an invalid redirect.".to_string())?;
    validate_url(next.as_str())
}

/// GET with validated DNS pinning and manual, validated redirects. Returns the final response.
pub async fn guarded_get(url: &str, user_agent: &str, timeout: Duration) -> Result<(reqwest::Response, reqwest::Url), String> {
    let mut current = validate_url(url)?;
    for _ in 0..=MAX_REDIRECTS {
        let addrs = resolve_public(&current).await?;
        let host = current.host_str().unwrap_or_default().to_string();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(timeout)
            .resolve_to_addrs(&host, &addrs)
            .build()
            .map_err(|_| "Couldn't start the request.".to_string())?;
        let response = client
            .get(current.clone())
            .header("User-Agent", user_agent)
            .send()
            .await
            .map_err(|e| if e.is_timeout() { "The site took too long to respond.".to_string() } else { "Couldn't reach that site.".to_string() })?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "The site sent an invalid redirect.".to_string())?;
            current = next_hop(&current, location)?;
            continue;
        }
        return Ok((response, current));
    }
    Err("The site redirected too many times.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn blocks_loopback_private_and_link_local_v4() {
        for a in ["127.0.0.1", "127.8.9.1", "10.0.0.1", "172.16.5.5", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255"] {
            assert!(ip_is_blocked(ip(a)), "{a} should be blocked");
        }
        for a in ["8.8.8.8", "1.1.1.1", "93.184.216.34"] {
            assert!(!ip_is_blocked(ip(a)), "{a} should be allowed");
        }
    }

    #[test]
    fn blocks_private_and_embedded_v6() {
        for a in ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::7f00:1", "2002:7f00:1::1", "::7f00:1"] {
            assert!(ip_is_blocked(ip(a)), "{a} should be blocked");
        }
        assert!(!ip_is_blocked(ip("2606:4700:4700::1111")));
        assert!(!ip_is_blocked(ip("::ffff:8.8.8.8")));
    }

    #[test]
    fn rejects_malformed_and_unsafe_urls() {
        for u in ["", "not a url", "ftp://example.org/", "file:///etc/passwd", "javascript:alert(1)", "http://", "https://user:pw@example.org/"] {
            assert!(validate_url(u).is_err(), "{u:?} should be rejected");
        }
        assert!(validate_url(&format!("https://example.org/{}", "a".repeat(3000))).is_err());
        assert!(validate_url("https://example.org/path?q=1").is_ok());
    }

    #[test]
    fn rejects_local_hostnames_and_numeric_ip_forms() {
        for u in [
            "http://localhost/",
            "http://LOCALHOST./",
            "http://app.localhost/",
            "http://printer.local/",
            "http://db.internal/",
            "http://intranet/",
            "http://127.0.0.1:11434/api/tags",
            "http://2130706433/",
            "http://0x7f.0.0.1/",
            "http://0177.0.0.1/",
            "http://127.1/",
            "http://[::1]/",
            "http://[::ffff:7f00:1]/",
            "http://169.254.169.254/latest/meta-data",
        ] {
            assert!(validate_url(u).is_err(), "{u} should be rejected");
        }
    }

    #[test]
    fn redirect_hops_are_validated() {
        let base = reqwest::Url::parse("https://example.org/a").unwrap();
        assert!(next_hop(&base, "/b").is_ok());
        assert!(next_hop(&base, "https://example.net/").is_ok());
        assert!(next_hop(&base, "http://127.0.0.1:11434/").is_err());
        assert!(next_hop(&base, "http://169.254.169.254/").is_err());
        assert!(next_hop(&base, "file:///c:/windows/win.ini").is_err());
        assert!(next_hop(&base, "//localhost/x").is_err());
    }

    #[test]
    fn guarded_get_refuses_local_server_without_connecting() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let result = tauri::async_runtime::block_on(guarded_get(&format!("http://127.0.0.1:{port}/"), "test", Duration::from_secs(3)));
        assert!(result.is_err());
        assert!(listener.accept().is_err(), "the guard must not open a connection");
    }
}

/// Local CONNECT-only proxy handed to the headless browser so that every connection the
/// page makes (subresources, redirects, scripts) is subject to the same IP checks.
pub struct BrowserProxy {
    pub port: u16,
    task: tokio::task::JoinHandle<()>,
}

impl BrowserProxy {
    pub async fn start() -> Result<Self, String> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { break };
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(Duration::from_secs(60), handle_proxy_conn(stream)).await;
                });
            }
        });
        Ok(Self { port, task })
    }
}

impl Drop for BrowserProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Extracts `host:port` from a CONNECT request head; None for anything else.
pub fn parse_connect_target(head: &str) -> Option<(String, u16)> {
    let line = head.lines().next()?;
    let mut parts = line.split_whitespace();
    if !parts.next()?.eq_ignore_ascii_case("CONNECT") {
        return None;
    }
    let target = parts.next()?;
    let (host, port) = target.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    if port != 443 && port != 80 {
        return None;
    }
    Some((host.trim_matches(|c| c == '[' || c == ']').to_string(), port))
}

async fn handle_proxy_conn(mut client: tokio::net::TcpStream) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 8192 {
        match client.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let head = String::from_utf8_lossy(&buf).into_owned();
    let Some((host, port)) = parse_connect_target(&head) else {
        let _ = client.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").await;
        return;
    };
    let Ok(url) = reqwest::Url::parse(&format!("https://{}:{}/", if host.contains(':') { format!("[{host}]") } else { host.clone() }, port)) else {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n").await;
        return;
    };
    let allowed = match validate_url(url.as_str()) {
        Ok(u) => resolve_public(&u).await,
        Err(e) => Err(e),
    };
    let Ok(addrs) = allowed else {
        let _ = client.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").await;
        return;
    };
    let Ok(mut upstream) = tokio::net::TcpStream::connect(addrs[0]).await else {
        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n").await;
        return;
    };
    if client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n").await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
}

#[cfg(test)]
mod proxy_tests {
    use super::parse_connect_target;

    #[test]
    fn connect_parsing_is_strict() {
        assert_eq!(parse_connect_target("CONNECT example.com:443 HTTP/1.1\r\n\r\n"), Some(("example.com".into(), 443)));
        assert_eq!(parse_connect_target("CONNECT [::1]:443 HTTP/1.1\r\n\r\n"), Some(("::1".into(), 443)));
        assert!(parse_connect_target("GET http://example.com/ HTTP/1.1\r\n\r\n").is_none());
        assert!(parse_connect_target("CONNECT example.com:22 HTTP/1.1\r\n\r\n").is_none());
    }
}
