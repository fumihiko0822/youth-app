/* 青年部アプリ Cloud Functions
 *
 * 役割：クライアントからはできない管理操作を、権限を確かめたうえで実行する。
 *   resetMemberPassword … 管理者がメンバーの暗証番号を再設定する
 *   setMemberAdmin      … 管理者権限を付与・解除する
 *
 * 重要：権限の判定は必ずこの中で行う。画面でボタンを隠すことは防御ではない。
 *
 * リージョンは asia-northeast1（東京）を明示する。指定しないと既定の
 * 米国リージョンに置かれ、要件定義書 §06「データ所在」の記述と食い違う。
 *
 * この関数を動かすには、実行サービスアカウント
 * （<プロジェクト番号>-compute@developer.gserviceaccount.com）に
 * 次の2つの権限が要る。近年作られたプロジェクトでは自動で付かない。
 *   - Cloud Datastore ユーザー（roles/datastore.user）… Firestore の読み書き
 *   - Firebase Authentication 管理者（roles/firebaseauth.admin）… パスワード変更
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getStorage } = require("firebase-admin/storage");

initializeApp();
const db = getFirestore();
const auth = getAuth();

const REGION = "asia-northeast1";
const APP_URL = "https://fumihiko0822.github.io/youth-app/";
const BUCKET = "ajramiyazaki-dx.firebasestorage.app";

/* ログは1本の文字列にする。
   logger.info("文言", {オブジェクト}) の形だと構造化ログになり、
   firebase functions:log では中身が空行になって読めない。
   引き継いだ人が最初に使うのはこのコマンドなので、そこで読める形にする。 */

/* 想定外の例外を、原因が分かる文言に変える。
   何もしないと画面には「実行できませんでした」としか出ず、引き継いだ人が
   原因にたどり着けない。よくある設定漏れはそれと分かる文言にし、
   詳細はログに残す。 */
function toHttpsError(e, context) {
  if (e instanceof HttpsError) return e;   // 意図して投げたものはそのまま通す

  logger.error(
    `想定外のエラー fn=${context && context.fn} code=${e && e.code} ` +
    `caller=${context && context.callerUid} target=${context && context.targetUid} ` +
    `message=${e && e.message}`
  );
  if (e && e.stack) logger.error(e.stack);

  const code = e && e.code;
  const text = String((e && e.message) || "");

  // Firestore（gRPC）の権限不足。code 7 = PERMISSION_DENIED
  if (code === 7 || code === "permission-denied" || text.includes("PERMISSION_DENIED")) {
    return new HttpsError(
      "internal",
      "サーバ側の権限が不足しています。関数の実行アカウント" +
        "（-compute@developer.gserviceaccount.com）に「Cloud Datastore ユーザー」" +
        "の権限を付けてください。"
    );
  }
  // Firebase Authentication 側の権限不足
  if (code === "auth/insufficient-permission") {
    return new HttpsError(
      "internal",
      "サーバ側の権限が不足しています。関数の実行アカウントに" +
        "「Firebase Authentication 管理者」の権限を付けてください。"
    );
  }
  if (code === "auth/user-not-found") {
    return new HttpsError(
      "not-found",
      "このメンバーのログインアカウントが見つかりません。" +
        "Authentication 側で削除された可能性があります。"
    );
  }
  if (code === "auth/invalid-password" || code === "auth/weak-password") {
    return new HttpsError("invalid-argument", "暗証番号は6文字以上にしてください。");
  }

  return new HttpsError(
    "internal",
    "想定外のエラーが発生しました" + (code ? "（" + code + "）" : "") +
      "。Cloud Functions のログを確認してください。"
  );
}

/* 呼び出し元が「有効な管理者」かを確かめ、その情報を返す。
   停止されたアカウントは、isAdmin が true でも通さない。 */
async function requireActiveAdmin(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "ログインが必要です。");
  }
  const snap = await db.collection("members").doc(uid).get();
  if (!snap.exists) {
    throw new HttpsError("permission-denied", "このアカウントは登録されていません。");
  }
  const data = snap.data();
  if (data.isAdmin !== true || data.status !== "active") {
    throw new HttpsError("permission-denied", "管理者だけが実行できます。");
  }
  return { uid, displayName: data.displayName || "" };
}

/* 操作の記録。新しい暗証番号そのものは決して残さない。 */
function writeAuditLog(entry) {
  return db.collection("auditLogs").add({
    ...entry,
    at: FieldValue.serverTimestamp(),
  });
}

/* ===== 暗証番号の再設定 =====
   Auth のパスワードは Admin SDK でしか他人の分を変更できない。
   UID は変わらないため、タスクの担当や確認記録はそのまま引き継がれる。 */
exports.resetMemberPassword = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth && request.auth.uid;
  const targetUid = request.data && request.data.uid;
  try {
    const me = await requireActiveAdmin(request);
    const password = request.data && request.data.password;

    if (typeof targetUid !== "string" || targetUid === "") {
      throw new HttpsError("invalid-argument", "対象のメンバーが指定されていません。");
    }
    if (typeof password !== "string" || password.length < 6) {
      throw new HttpsError("invalid-argument", "暗証番号は6文字以上にしてください。");
    }

    // このアプリが管理しているアカウントに限る
    const target = await db.collection("members").doc(targetUid).get();
    if (!target.exists) {
      throw new HttpsError("not-found", "対象のメンバーが見つかりません。");
    }

    await auth.updateUser(targetUid, { password });

    await writeAuditLog({
      type: "passwordReset",
      byUid: me.uid,
      byName: me.displayName,
      targetUid,
      targetName: target.data().displayName || "",
    });

    logger.info(`暗証番号を再設定した by=${me.uid} target=${targetUid}`);
    return { ok: true };
  } catch (e) {
    throw toHttpsError(e, { fn: "resetMemberPassword", callerUid, targetUid });
  }
});

/* ===== メンバーの完全削除 =====
   Authentication と Firestore の両方から消す。
   順序は Auth が先。逆にすると、Firestore だけ消えて Auth が残ったときに
   一覧から見えなくなり、同じIDで再発行もできなくなる（email-already-in-use）。
   Auth を先に消しておけば、途中で失敗しても行が残るので押し直せる。

   管理者はそのままでは削除できない。先に「管理者を外す」を通してもらう。
   こうすると、削除によって管理者が0人になる経路そのものが無くなる。
   （権限の解除は setMemberAdmin がトランザクションで1人以上を保証している）

   タスクは巻き添えで消さない。担当が全員いなくなったタスクは、管理一覧に
   「有効な担当者がいません」と出るので、管理者が見て判断する。 */
exports.deleteMember = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth && request.auth.uid;
  const targetUid = request.data && request.data.uid;
  try {
    const me = await requireActiveAdmin(request);

    if (typeof targetUid !== "string" || targetUid === "") {
      throw new HttpsError("invalid-argument", "対象のメンバーが指定されていません。");
    }
    if (targetUid === me.uid) {
      throw new HttpsError("failed-precondition", "自分自身は削除できません。");
    }

    const targetRef = db.collection("members").doc(targetUid);
    const target = await targetRef.get();
    if (!target.exists) {
      throw new HttpsError("not-found", "対象のメンバーが見つかりません。");
    }
    const targetData = target.data();

    if (targetData.isAdmin === true) {
      throw new HttpsError(
        "failed-precondition",
        "管理者は削除できません。先に「管理者を外す」を実行してください。"
      );
    }

    // 1) Authentication を先に消す。すでにいない場合は成功として扱い、
    //    Firestore の掃除に進む（同じ操作をもう一度押せるようにするため）。
    try {
      await auth.deleteUser(targetUid);
    } catch (e) {
      if (!e || e.code !== "auth/user-not-found") throw e;
      logger.warn(`Authにアカウントがなかった。掃除だけ続ける target=${targetUid}`);
    }

    // 2) タスクからこの人への参照を取り除く（タスク自体は消さない）
    const taskSnap = await db
      .collection("tasks")
      .where("assigneeUids", "array-contains", targetUid)
      .get();

    const writes = [];
    taskSnap.docs.forEach((d) => {
      writes.push({
        op: "update",
        ref: d.ref,
        data: {
          assigneeUids: FieldValue.arrayRemove(targetUid),
          ["progress." + targetUid]: FieldValue.delete(),
          ["reworkNotes." + targetUid]: FieldValue.delete(),
        },
      });
    });

    // 3) 確認記録と同意記録を消す（どちらも単一フィールドの検索）
    const readSnap = await db.collection("reads").where("uid", "==", targetUid).get();
    readSnap.docs.forEach((d) => writes.push({ op: "delete", ref: d.ref }));

    const consentSnap = await db.collection("consents").where("uid", "==", targetUid).get();
    consentSnap.docs.forEach((d) => writes.push({ op: "delete", ref: d.ref }));

    // この人が追加したリンク・添付ファイルも消す（確認記録・同意記録と同じ扱い）
    const linkSnap = await db.collection("attachments").where("byUid", "==", targetUid).get();
    linkSnap.docs.forEach((d) => writes.push({ op: "delete", ref: d.ref }));

    // 添付ファイルは Storage の実体も消す。Firestore の記録だけ消すと、
    // 誰からも見えないファイルが容量だけ使い続けることになる。
    const paths = linkSnap.docs.map((d) => d.data().storagePath).filter(Boolean);
    for (const path of paths) {
      try {
        await getStorage().bucket(BUCKET).file(path).delete();
      } catch (e) {
        // すでに無い場合は成功として扱い、掃除を続ける
        logger.warn(`ファイル本体の削除に失敗 path=${path} code=${e && e.code}`);
      }
    }

    // 4) アカウント本体
    writes.push({ op: "delete", ref: targetRef });

    // バッチの上限は500件。20人規模では届かないが、超えても壊れないよう分割する。
    for (let i = 0; i < writes.length; i += 400) {
      const batch = db.batch();
      writes.slice(i, i + 400).forEach((w) => {
        if (w.op === "delete") batch.delete(w.ref);
        else batch.update(w.ref, w.data);
      });
      await batch.commit();
    }

    const counts = {
      tasks: taskSnap.size,
      reads: readSnap.size,
      consents: consentSnap.size,
      links: linkSnap.size,
    };

    await writeAuditLog({
      type: "memberDelete",
      byUid: me.uid,
      byName: me.displayName,
      targetUid,
      targetName: targetData.displayName || "",
      targetLoginId: targetData.loginId || "",
      cleaned: counts,
    });

    logger.info(
      `メンバーを削除した by=${me.uid} target=${targetUid} ` +
      `タスク${counts.tasks}件／確認記録${counts.reads}件／同意${counts.consents}件／リンク${counts.links}件`
    );
    return { ok: true, counts };
  } catch (e) {
    throw toHttpsError(e, { fn: "deleteMember", callerUid, targetUid });
  }
});

/* ===== 管理者権限の付与・解除 =====
   自分自身は変更できない。加えて、解除後も「有効な管理者」が1人以上残ることを
   トランザクションの中で確かめる。自分自身の解除を禁じるだけでは、2人の管理者が
   同時に互いを解除したときに0人になり得るため。 */
exports.setMemberAdmin = onCall({ region: REGION }, async (request) => {
  const callerUid = request.auth && request.auth.uid;
  const targetUid = request.data && request.data.uid;
  try {
    const me = await requireActiveAdmin(request);
    const makeAdmin = request.data && request.data.makeAdmin;

    if (typeof targetUid !== "string" || targetUid === "") {
      throw new HttpsError("invalid-argument", "対象のメンバーが指定されていません。");
    }
    if (typeof makeAdmin !== "boolean") {
      throw new HttpsError("invalid-argument", "付与か解除かが指定されていません。");
    }
    if (targetUid === me.uid) {
      throw new HttpsError("failed-precondition", "自分自身の管理者権限は変更できません。");
    }

    const targetRef = db.collection("members").doc(targetUid);
    let targetName = "";

    await db.runTransaction(async (tx) => {
      // トランザクションでは、読み取りをすべて済ませてから書き込む
      const target = await tx.get(targetRef);
      if (!target.exists) {
        throw new HttpsError("not-found", "対象のメンバーが見つかりません。");
      }
      targetName = target.data().displayName || "";

      if (!makeAdmin) {
        // status での絞り込みはコード側で行う（複合インデックスを避ける方針を維持）
        const admins = await tx.get(
          db.collection("members").where("isAdmin", "==", true)
        );
        const remaining = admins.docs.filter(
          (d) => d.id !== targetUid && d.data().status === "active"
        ).length;
        if (remaining < 1) {
          throw new HttpsError(
            "failed-precondition",
            "管理者が0人になるため解除できません。先に別のメンバーを管理者にしてください。"
          );
        }
      }

      tx.update(targetRef, { isAdmin: makeAdmin });
    });

    await writeAuditLog({
      type: makeAdmin ? "adminGrant" : "adminRevoke",
      byUid: me.uid,
      byName: me.displayName,
      targetUid,
      targetName,
    });

    logger.info(
      `${makeAdmin ? "管理者権限を付与した" : "管理者権限を解除した"} by=${me.uid} target=${targetUid}`
    );
    return { ok: true };
  } catch (e) {
    throw toHttpsError(e, { fn: "setMemberAdmin", callerUid, targetUid });
  }
});

/* ===== プッシュ通知（FR-7） =====
   きっかけは Firestore の変化。呼び出し元が Eventarc のため、
   Callable のような「未認証の呼び出しを許可」の設定は要らない。

   通知は data だけを送り、中身の組み立ては sw.js 側で行う。
   notification 付きで送ると、自動表示と自前の表示が二重になる環境がある。

   iOS ではホーム画面に追加したアプリでしか通知を受け取れない。
   トークンが1つも無い人には、そもそも何も送られない。 */

async function pushTo(uids, title, body) {
  const list = [...new Set(uids)].filter(Boolean);
  if (!list.length) return;

  const snaps = await Promise.all(
    list.map((u) => db.collection("members").doc(u).get())
  );

  const owner = {};   // token => uid（無効だったときに持ち主を辿るため）
  snaps.forEach((s) => {
    if (!s.exists) return;
    const d = s.data();
    if (d.status !== "active") return;          // 停止中には送らない
    (d.fcmTokens || []).forEach((t) => { owner[t] = s.id; });
  });

  const tokens = Object.keys(owner);
  if (!tokens.length) {
    // 黙って何もしないと、通知が来ない原因がまったく追えない
    logger.info(
      `通知[${title}] 対象${list.length}人／通知を許可した端末が0件のため送信しない`
    );
    return;
  }

  // notification を付けて送る。data だけだと iOS では届かない。
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title: String(title), body: String(body || "") },
    webpush: {
      headers: { Urgency: "high" },
      notification: {
        title: String(title),
        body: String(body || ""),
        icon: APP_URL + "icon-192.png",
        badge: APP_URL + "icon-192.png",
        tag: "youth-app",
      },
      fcmOptions: { link: APP_URL },
    },
  });

  // 端末を消した、ホーム画面から外したなどで無効になったトークンを取り除く。
  // 放置すると、以後ずっと失敗するトークンに送り続けることになる。
  const dead = [];
  res.responses.forEach((r, i) => {
    if (r.success) return;
    const code = (r.error && r.error.code) || "";
    if (code === "messaging/registration-token-not-registered"
      || code === "messaging/invalid-registration-token"
      || code === "messaging/invalid-argument") {
      dead.push(tokens[i]);
    } else {
      logger.warn(`通知の送信に失敗 code=${code} uid=${owner[tokens[i]]}`);
    }
  });
  await Promise.all(dead.map((t) =>
    db.collection("members").doc(owner[t])
      .update({ fcmTokens: FieldValue.arrayRemove(t) })
  ));

  logger.info(
    `通知[${title}] 対象${list.length}人／宛先${tokens.length}件／` +
    `成功${res.successCount}件／失敗${res.failureCount}件／無効を除去${dead.length}件`
  );
}

/* 新しいタスク → 担当者へ（作った本人には送らない） */
exports.onTaskCreated = onDocumentCreated(
  { region: REGION, document: "tasks/{taskId}" },
  async (event) => {
    const t = event.data && event.data.data();
    if (!t) return;
    const to = (t.assigneeUids || []).filter((u) => u !== t.createdBy);
    logger.info(`onTaskCreated 起動 title=${t.title} 担当${(t.assigneeUids || []).length}人 宛先${to.length}人`);
    await pushTo(to, "新しいタスク", t.title || "");
  }
);

/* 新しい予定 → 有効なメンバー全員へ（作った本人には送らない） */
exports.onScheduleCreated = onDocumentCreated(
  { region: REGION, document: "schedules/{scheduleId}" },
  async (event) => {
    const s = event.data && event.data.data();
    if (!s) return;
    const snap = await db.collection("members").where("status", "==", "active").get();
    const to = snap.docs.map((d) => d.id).filter((u) => u !== s.createdBy);
    logger.info(`onScheduleCreated 起動 title=${s.title} 宛先${to.length}人`);
    await pushTo(to, "新しい予定", (s.title || "") + (s.date ? "（" + s.date + "）" : ""));
  }
);

/* 差戻 → 差し戻された本人へ。
   タスクの更新は進捗が動くたびに起きるので、「差戻」に変わった人だけを拾う。 */
exports.onTaskReworked = onDocumentUpdated(
  { region: REGION, document: "tasks/{taskId}" },
  async (event) => {
    const before = (event.data.before && event.data.before.data()) || {};
    const after = (event.data.after && event.data.after.data()) || {};
    const b = before.progress || {};
    const a = after.progress || {};
    const to = Object.keys(a).filter((u) => a[u] === "差戻" && b[u] !== "差戻");
    if (!to.length) return;   // 進捗の更新は頻繁に起きるので、差戻以外は何も出さない
    logger.info(`onTaskReworked 起動 title=${after.title} 宛先${to.length}人`);
    await pushTo(to, "タスクが差し戻されました", after.title || "");
  }
);

/* 新しいお知らせ → 有効なメンバー全員へ（投稿した本人には送らない）。
   予定の通知と同じ形。Firestoreトリガーなので、Callable と違って
   Cloud Run の「パブリック アクセスを許可」は要らない（制約Q）。 */
exports.onPostCreated = onDocumentCreated(
  { region: REGION, document: "posts/{postId}" },
  async (event) => {
    const post = event.data && event.data.data();
    if (!post) return;
    const snap = await db.collection("members").where("status", "==", "active").get();
    const to = snap.docs.map((d) => d.id).filter((u) => u !== post.createdBy);
    logger.info(`onPostCreated 起動 title=${post.title} 宛先${to.length}人`);
    await pushTo(to, "新しいお知らせ", post.title || "");
  }
);
