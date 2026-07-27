# Public vs private plane

## Public (AT Protocol PDS)

- Signed firmware / package / container releases  
- Device public identity (fingerprint, public keys)  
- Enrollment membership  
- Optional “job pending” signals (no secrets)

## Private (control plane API)

- Join approval queue  
- Password / credential updates  
- Private config jobs  
- Encrypted to the device’s X25519 key; server stores **ciphertext only**

```
Admin utility  --TLS+token-->  Control API  --sealed job-->  Device agent
                                      ^
Device join / job pull  --------------+
```

Never put passwords in public AT records.
