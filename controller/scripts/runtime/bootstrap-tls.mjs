import { createPrivateKey, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function tlsFields(spec) {
  return [spec.caKey, spec.serverCertificateKey, spec.serverPrivateKeyKey, spec.clientCertificateKey, spec.clientPrivateKeyKey, spec.caPrivateKeyKey ?? "ca.key"];
}

export function generateTls(spec, authority) {
  if (!spec.serverDnsNames?.length || [...spec.serverDnsNames, spec.runnerName].some(name => !/^[a-zA-Z0-9.-]+$/.test(name))) {
    throw new Error("Invalid mTLS certificate DNS names.");
  }
  const dir = mkdtempSync(join(tmpdir(), "guard-tls-"));
  const run = args => execFileSync("openssl", args, { cwd: dir, stdio: "ignore", timeout: 30_000 });
  try {
    if (authority) {
      validateAuthority(spec, authority);
      writeFileSync(join(dir, "ca.crt"), authority[spec.caKey], { mode: 0o600 });
      writeFileSync(join(dir, "ca.key"), authority[spec.caPrivateKeyKey ?? "ca.key"], { mode: 0o600 });
    } else {
      writeFileSync(join(dir, "ca.cnf"), `[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\nCN=${spec.serverDnsNames[0]}-ca\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n`, { mode: 0o600 });
      run(["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256", "-days", "3650", "-config", "ca.cnf", "-keyout", "ca.key", "-out", "ca.crt"]);
    }
    const ca = new X509Certificate(readFileSync(join(dir, "ca.crt")));
    const days = String(Math.floor((Date.parse(ca.validTo) - Date.now()) / 86_400_000));
    if (Number(days) < 1) throw new Error("CA expires too soon to issue certificates");
    for (const [role, name, usage] of [["server", spec.serverDnsNames[0], "serverAuth"], ["client", spec.runnerName, "clientAuth"]]) {
      run(["req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-sha256", "-subj", `/CN=${name}`, "-keyout", `${role}.key`, "-out", `${role}.csr`]);
      const dns = role === "server" ? spec.serverDnsNames : [name];
      writeFileSync(join(dir, `${role}.cnf`), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${usage}\nsubjectAltName=${dns.map(value => `DNS:${value}`).join(",")}\n`, { mode: 0o600 });
      run(["x509", "-req", "-sha256", "-days", days, "-in", `${role}.csr`, "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-extfile", `${role}.cnf`, "-out", `${role}.crt`]);
    }
    const data = Object.fromEntries(tlsFields(spec).map((key, index) => [key, readFileSync(join(dir, ["ca.crt", "server.crt", "server.key", "client.crt", "client.key", "ca.key"][index]), "utf8")]));
    validateTls(spec, data);
    return data;
  } catch {
    throw new Error("mTLS certificate generation failed; no existing Secret was changed.");
  } finally {
    // The writable directory is a memory-backed volume in the initialization Job.
    rmSync(dir, { recursive: true, force: true });
  }
}

function validateAuthority(spec, data) {
  const ca = new X509Certificate(data[spec.caKey]);
  if (!ca.ca || !ca.verify(ca.publicKey) || !ca.checkPrivateKey(createPrivateKey(data[spec.caPrivateKeyKey ?? "ca.key"])) || Date.parse(ca.validFrom) > Date.now() || Date.parse(ca.validTo) <= Date.now()) throw new Error("Invalid persistent CA");
}

export function validateTls(spec, data) {
  try {
    const ca = new X509Certificate(data[spec.caKey]);
    const server = new X509Certificate(data[spec.serverCertificateKey]);
    const client = new X509Certificate(data[spec.clientCertificateKey]);
    const now = Date.now();
    if (![ca, server, client].every(cert => Date.parse(cert.validFrom) <= now && Date.parse(cert.validTo) > now)) throw new Error("Expired certificate");
    if (!ca.ca || !ca.verify(ca.publicKey)) throw new Error("Invalid CA");
    if (data[spec.caPrivateKeyKey ?? "ca.key"]) validateAuthority(spec, data);
    for (const [cert, key, usage] of [[server, spec.serverPrivateKeyKey, "1.3.6.1.5.5.7.3.1"], [client, spec.clientPrivateKeyKey, "1.3.6.1.5.5.7.3.2"]]) {
      if (cert.ca || !cert.checkIssued(ca) || !cert.verify(ca.publicKey) || !cert.checkPrivateKey(createPrivateKey(data[key])) || !cert.keyUsage?.includes(usage)) throw new Error("Invalid leaf certificate");
    }
    if (!spec.serverDnsNames.every(name => server.checkHost(name))) throw new Error("Server DNS mismatch");
  } catch {
    throw new Error(`Secret ${spec.name} has expired or incompatible mTLS certificates, keys, or DNS names; refusing automatic rotation. Renew the certificate bundle and restart Controller and Runners together.`);
  }
}
