/**
 * The short notices that point at `/legal` from other screens.
 *
 * `/legal` itself switches its headings, versions and tab title on enactment
 * (#291). The screens that link to it did not: the login page said
 * 「未施行の案です」 and the consent screens said 「確認用草案です」 as fixed
 * text, so a deployment that had enacted the documents would still tell a
 * person signing up that there was nothing in force — the same two-names-on-
 * one-product problem, one click earlier.
 *
 * Each notice follows the switch that governs the documents it points at, and
 * the two switches stay separate for the reason `consentDocument.ts` gives:
 * enacting the terms says nothing about the research consent pack.
 */

import { consentDocumentV2Enacted } from "./consentDocument.ts";
import { legalEnacted } from "./legalEnactment.ts";

export type LegalNotice = { link: string; note: string };

/** Under the login form: the terms and the privacy policy. */
export function loginLegalNotice(): LegalNotice {
  if (legalEnacted()) {
    return {
      link: "利用規約・プライバシーポリシー（別タブ）",
      // True of the product: an acceptance row is written only by the button
      // under each document on `/legal`, never by signing up.
      note: "登録操作だけでは同意として記録されません。同意は書類のページで、文書ごとに行います。",
    };
  }
  return {
    link: "利用規約・プライバシーポリシーの確認用草案（別タブ）",
    note: "未施行の案です。登録操作をこの草案への同意として記録しません。",
  };
}

/** On the consent, join and guardian screens: the research documents. */
export function researchDocumentNotice(audience: "research" | "guardian"): LegalNotice {
  if (consentDocumentV2Enacted()) {
    return {
      link: audience === "guardian" ? "保護者向け説明・確認の全文を読む（別タブ）" : "研究説明・同意の全文を読む（別タブ）",
      note: "説明文書の全文は別タブで確認できます。閲覧しただけでは同意として記録されません。",
    };
  }
  return {
    link: audience === "guardian" ? "保護者向け説明・確認の改訂案を読む（別タブ）" : "研究説明・同意の改訂案を読む（別タブ）",
    note: "改訂書類は確認用草案です。既存の同意文書の版とは異なり、この草案の閲覧を同意として記録しません。",
  };
}
