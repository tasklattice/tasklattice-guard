import test from 'node:test';
import assert from 'node:assert/strict';
import { configuration, LABEL, managedPlist, renderPlist, xml } from './local-k8s-access.mjs';

test('defaults bridge only loopback to the existing Controller Service', () => {
  const config = configuration({ GUARD_K8S_ACCESS_SERVICE: 'configured-controller' }, { root: '/private/repo', userHome: '/private/user' });
  const plist = renderPlist(config, '/absolute/kubectl');
  assert.equal(config.kubeconfig, '/private/user/.kube/config');
  assert.equal(config.namespace, 'default');
  assert.equal(config.plist, `/private/user/Library/LaunchAgents/${LABEL}.plist`);
  assert(plist.includes('<string>127.0.0.1</string>'));
  assert(plist.includes('<string>service/configured-controller</string><string>38081:8080</string>'));
  assert(plist.includes('<key>RunAtLoad</key><true/>'));
  assert(plist.includes('<key>KeepAlive</key><true/>'));
  assert(plist.includes('<key>ThrottleInterval</key><integer>5</integer>'));
  assert(!plist.includes('0.0.0.0'));
  assert(managedPlist(plist));
});

test('validation rejects invalid port/service/path inputs before installation', () => {
  const env = { GUARD_K8S_ACCESS_SERVICE: 'configured-controller' };
  assert.throws(() => configuration({}), /GUARD_K8S_ACCESS_SERVICE/);
  for (const value of ['0', '80', '65536', '1.5', 'NaN', '', ' 38081'])
    assert.throws(() => configuration({ ...env, GUARD_K8S_ACCESS_PORT: value }));
  for (const value of ['0', '65536', '1.2'])
    assert.throws(() => configuration({ ...env, GUARD_K8S_ACCESS_TARGET_PORT: value }));
  for (const value of ['Other', '-service', 'service/', 'a'.repeat(64)])
    assert.throws(() => configuration({ GUARD_K8S_ACCESS_SERVICE: value }));
  assert.throws(() => configuration({ ...env, GUARD_K8S_ACCESS_KUBECONFIG: 'bad\npath' }));
  assert.throws(() => renderPlist(configuration(env), 'relative/kubectl'));
});

test('paths are XML escaped and never become shell commands', () => {
  assert.equal(xml('&<>"\''), '&amp;&lt;&gt;&quot;&apos;');
  const config = configuration({ GUARD_K8S_ACCESS_SERVICE: 'configured-controller', GUARD_K8S_ACCESS_KUBECONFIG: '/private/a & <b>/config' });
  const plist = renderPlist(config, '/private/tools & bins/kubectl');
  assert(plist.includes('<string>/private/a &amp; &lt;b&gt;/config</string>'));
  assert(plist.includes('<string>/private/tools &amp; bins/kubectl</string>'));
  assert(!plist.includes('/bin/sh'));
});

test('same-label unrelated LaunchAgents are not treated as owned', () => {
  assert.equal(managedPlist(`<plist><key>Label</key><string>${LABEL}</string></plist>`), false);
  const ours = renderPlist(configuration({ GUARD_K8S_ACCESS_SERVICE: 'configured-controller' }), '/absolute/kubectl');
  assert.equal(managedPlist(ours.replace(LABEL, 'io.unrelated.job')), false);
});
