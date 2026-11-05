// Security audit tool: real posture read from the live devices.

import { audit_security } from "../../../domain/services/security_audit.js";
import { WALK_JS } from "../../../infrastructure/generator/walk_js.js";
import { TIMEOUT_MSG } from "../bridge_context.js";
import { reply_json } from "../../../shared/utils.js";


export async function register(registry, ctx) {
    /** Register this module's tools on `registry`. */
    const _TIMEOUT_MSG = TIMEOUT_MSG;
    const _bridge_send_and_wait = async (js, timeout) => await ctx.send_and_wait(js, timeout);
    const _check_bridge = async () => await ctx.check_bridge();

    // ------------------------------------------------------------------
    // SECURITY AUDIT — real posture read from the live devices
    // ------------------------------------------------------------------

    // Classifies each credential by its prefix and returns ONLY the algorithm
    // label. The hash never crosses the bridge: it would end up in the LLM's context
    // and in the MCP client's logs, and the label is enough to audit.
    // Verified against PT 9.0.0.0810: `enable secret`/`username X secret` give
    // "$1$...", and `username X password` with service-password-encryption gives hex
    // type-7 (reversible with public decoders).
    const _AUDIT_ALGO_JS = (
        "function __algo(s){"
        + "  if(!s) return null;"
        + "  s = String(s);"
        + "  if(s.indexOf('$1$')===0) return 'md5';"
        + "  if(s.indexOf('$8$')===0) return 'pbkdf2';"
        + "  if(s.indexOf('$9$')===0) return 'scrypt';"
        + "  if(/^[0-9A-Fa-f]{4,}$/.test(s)) return 'type7';"
        + "  return 'plaintext';"
        + "}"
    );

    const _SECURITY_AUDIT_JS = (
        "try {"
        + _AUDIT_ALGO_JS + WALK_JS +
        "  var __out = [];"
        + "  __eachDevice(function(__d) {"
        // Hosts (PC/Server/Laptop) expose no IOS configuration: calling
        // these getters there throws and opens a modal that freezes the bridge.
        + "      if (typeof __d.getEnableSecret !== 'function') return;"
        + "      var __users = [];"
        + "      try {"
        + "        var __uc = __d.getUserPassCount();"
        + "        for (var __j = 0; __j < __uc; __j++) {"
        // getUserEntryAt throws 'out of bound' instead of returning null, so
        // each read carries its own guard.
        + "          try {"
        + "            var __u = String(__d.getUserEntryAt(__j));"
        // The 2960 lists its users but has no getUserPass(): keep the user with an
        // unknown algorithm instead of dropping it (it would read as "no local users").
        + "            __users.push({ name: __u, algo: (typeof __d.getUserPass === 'function')"
        + "              ? __algo(__d.getUserPass(__u)) : null });"
        + "          } catch (__ue) {}"
        + "        }"
        + "      } catch (__uce) {}"
        + "      var __sec = __d.getEnableSecret();"
        + "      var __pwd = __d.getEnablePassword();"
        + "      __out.push({"
        + "        name: __d.getName(),"
        + "        model: (typeof __d.getModel === 'function') ? __d.getModel() : '',"
        + "        hostname: (typeof __d.getHostName === 'function') ? __d.getHostName() : '',"
        + "        enable_secret_set: !!__sec,"
        + "        enable_secret_algo: __algo(__sec),"
        + "        enable_password_set: !!__pwd,"
        + "        service_password_encryption: (typeof __d.getServicePasswordEncryption === 'function')"
        + "          ? !!__d.getServicePasswordEncryption() : false,"
        + "        banner_set: (typeof __d.getBannerMotd === 'function')"
        + "          ? !!__d.getBannerMotd() : false,"
        + "        users: __users,"
        + "        config_register: (typeof __d.getConfigRegister === 'function')"
        + "          ? __d.getConfigRegister() : null"
        + "      });"
        + "  });"
        + "  reportResult(JSON.stringify({ devices: __out }));"
        + "} catch (__e) { reportResult('ERROR:' + __e); }"
    );

    registry.tool("pt_audit_security", async (args) => {
        const device = args.device !== undefined ? args.device : "";
        const err = await _check_bridge();
        if (err) {
            return err;
        }

        const raw = await _bridge_send_and_wait(_SECURITY_AUDIT_JS, 12.0);
        if (raw === null || raw === undefined) {
            return _TIMEOUT_MSG;
        }
        if (raw.startsWith("ERROR:")) {
            return `PT error: ${raw}`;
        }

        let devices;
        try {
            const parsed = JSON.parse(raw);
            devices = parsed["devices"] !== undefined ? parsed["devices"] : [];
        } catch (exc) {
            return `Unreadable reply from PT: ${exc.message !== undefined ? exc.message : exc}`;
        }

        const wanted = device.trim();
        if (wanted) {
            devices = devices.filter((d) => d["name"] === wanted);
            if (!devices.length) {
                return (
                    `'${wanted}' does not exist in the active topology or has no `
                    + "IOS configuration (PCs and servers don't have one). "
                    + "Use pt_query_topology to see the real names."
                );
            }
        }

        const result = audit_security(devices);
        const counts = result["counts"];
        if (!devices.length) {
            result["summary"] = "There are no devices with an IOS configuration on the canvas.";
        } else if (result["secure"]) {
            result["summary"] = (
                `✅ ${result['devices_audited']} device(s) audited, `
                + `no high or medium findings (${counts['low']} low).`
            );
        } else {
            result["summary"] = (
                `⚠ ${counts['high']} high finding(s), ${counts['medium']} medium, `
                + `${counts['low']} low on ${result['devices_audited']} device(s).`
            );
        }
        return reply_json(result);
    });
}
