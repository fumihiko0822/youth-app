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
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();
const auth = getAuth();

const REGION = "asia-northeast1";

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
  const me = await requireActiveAdmin(request);

  const targetUid = request.data && request.data.uid;
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

  return { ok: true };
});

/* ===== 管理者権限の付与・解除 =====
   自分自身は変更できない。加えて、解除後も「有効な管理者」が1人以上残ることを
   トランザクションの中で確かめる。自分自身の解除を禁じるだけでは、2人の管理者が
   同時に互いを解除したときに0人になり得るため。 */
exports.setMemberAdmin = onCall({ region: REGION }, async (request) => {
  const me = await requireActiveAdmin(request);

  const targetUid = request.data && request.data.uid;
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

  return { ok: true };
});
