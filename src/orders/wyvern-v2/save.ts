import * as Sdk from "@reservoir0x/sdk";

import { bn } from "@/common/bignumber";
import { db, pgp } from "@/common/db";
import { config } from "@/config/index";
import {
  TokenSetInfo,
  TokenSetLabelKind,
  generateTokenInfo,
  generateCollectionInfo,
} from "@/orders/utils";
import { addToOrdersUpdateByHashQueue } from "@/jobs/orders-update";

type OrderInfo = {
  kind: TokenSetLabelKind;
  data?: any;
};

const extractOrderInfo = (order: Sdk.WyvernV2.Order): OrderInfo | undefined => {
  switch (order.params.kind) {
    case "erc721-single-token": {
      const builder = new Sdk.WyvernV2.Builders.Erc721.SingleToken(
        config.chainId
      );

      return {
        kind: "token",
        data: {
          tokenId: builder.getTokenId(order),
        },
      };
    }

    case "erc1155-single-token": {
      const builder = new Sdk.WyvernV2.Builders.Erc1155.SingleToken(
        config.chainId
      );

      return {
        kind: "token",
        data: {
          tokenId: builder.getTokenId(order),
        },
      };
    }

    case "erc721-token-range": {
      const builder = new Sdk.WyvernV2.Builders.Erc721.TokenRange(
        config.chainId
      );

      return {
        kind: "collection",
        data: {
          tokenIdRange: builder.getTokenIdRange(order),
        },
      };
    }

    case "erc1155-token-range": {
      const builder = new Sdk.WyvernV2.Builders.Erc1155.TokenRange(
        config.chainId
      );

      return {
        kind: "collection",
        data: {
          tokenIdRange: builder.getTokenIdRange(order),
        },
      };
    }

    case "erc721-contract-wide": {
      return {
        kind: "collection",
      };
    }

    case "erc1155-contract-wide": {
      return {
        kind: "collection",
      };
    }

    default: {
      return undefined;
    }
  }
};

export const saveOrders = async (orders: Sdk.WyvernV2.Order[]) => {
  if (!orders.length) {
    return;
  }

  const queries: any[] = [];
  for (const order of orders) {
    const orderInfo = extractOrderInfo(order);
    if (!orderInfo) {
      continue;
    }

    let tokenSetInfo: TokenSetInfo | undefined;
    switch (orderInfo.kind) {
      // We have a single-token order
      case "token": {
        tokenSetInfo = generateTokenInfo(
          order.params.target,
          orderInfo.data?.tokenId
        );

        // Create the token set
        queries.push({
          query: `
            insert into "token_sets" (
              "id",
              "contract",
              "token_id",
              "label",
              "label_hash"
            ) values (
              $/tokenSetId/,
              $/contract/,
              $/tokenId/,
              $/tokenSetLabel/,
              $/tokenSetLabelHash/
            ) on conflict do nothing
          `,
          values: {
            tokenSetId: tokenSetInfo.id,
            contract: order.params.target,
            tokenId: orderInfo.data.tokenId,
            tokenSetLabel: tokenSetInfo.label,
            tokenSetLabelHash: tokenSetInfo.labelHash,
          },
        });

        // For increased performance, only trigger the insertion of
        // corresponding tokens in the token set if we don't already
        // have them stored in the database
        const tokenSetTokensExists = await db.oneOrNone(
          `
            select 1
            from "token_sets_tokens" "tst"
            where "tst"."token_set_id" = $/tokenSetId/
            limit 1
          `,
          { tokenSetId: tokenSetInfo.id }
        );
        if (!tokenSetTokensExists) {
          // Insert matching tokens in the token set
          queries.push({
            query: `
            insert into "token_sets_tokens" (
              "token_set_id",
              "contract",
              "token_id"
            ) values (
              $/tokenSetId/,
              $/contract/,
              $/tokenId/
            ) on conflict do nothing
          `,
            values: {
              tokenSetId: tokenSetInfo.id,
              contract: order.params.target,
              tokenId: orderInfo.data.tokenId,
            },
          });
        }

        break;
      }

      // We have a collection-wide order
      case "collection": {
        // Fetch the collection's contract and associated token range
        // (if any). The order must exactly match the collection's
        // definition in order for it to be properly validated.

        let collection: { id: string } | null;
        if (orderInfo.data?.tokenIdRange) {
          collection = await db.oneOrNone(
            `
              select
                "c"."id"
              from "collections" "c"
              where "c"."contract" = $/contract/
                and "c"."token_id_range" = numrange($/startTokenId/, $/endTokenId/, '[]')
            `,
            {
              contract: order.params.target,
              startTokenId: orderInfo.data.tokenIdRange[0],
              endTokenId: orderInfo.data.tokenIdRange[1],
            }
          );
        } else {
          collection = await db.oneOrNone(
            `
              select
                "c"."id"
              from "collections" "c"
              where "c"."contract" = $/contract/
                and (
                  "c"."token_id_range" is null or "c"."token_id_range" = numrange(null, null)
                )
            `,
            {
              contract: order.params.target,
            }
          );
        }

        if (collection) {
          tokenSetInfo = generateCollectionInfo(
            collection.id,
            order.params.target,
            orderInfo.data?.tokenIdRange
          );

          // Create the token set
          queries.push({
            query: `
              insert into "token_sets" (
                "id",
                "collection_id",
                "label",
                "label_hash"
              ) values (
                $/tokenSetId/,
                $/collectionId/,
                $/tokenSetLabel/,
                $/tokenSetLabelHash/
              ) on conflict do nothing
            `,
            values: {
              tokenSetId: tokenSetInfo.id,
              collectionId: collection.id,
              tokenSetLabel: tokenSetInfo.label,
              tokenSetLabelHash: tokenSetInfo.labelHash,
            },
          });

          // For increased performance, only trigger the insertion of
          // corresponding tokens in the token set if we don't already
          // have them stored in the database
          const tokenSetTokensExists = await db.oneOrNone(
            `
              select 1
              from "token_sets_tokens" "tst"
              where "tst"."token_set_id" = $/tokenSetId/
              limit 1
            `,
            { tokenSetId: tokenSetInfo.id }
          );
          if (!tokenSetTokensExists) {
            // Insert matching tokens in the token set
            queries.push({
              query: `
                insert into "token_sets_tokens" (
                  "token_set_id",
                  "contract",
                  "token_id"
                )
                (
                  select
                    $/tokenSetId/,
                    "t"."contract",
                    "t"."token_id"
                  from "tokens" "t"
                  where "t"."collection_id" = $/collection/
                ) on conflict do nothing
              `,
              values: {
                tokenSetId: tokenSetInfo.id,
                collection: collection.id,
              },
            });
          }
        }

        break;
      }
    }

    if (!tokenSetInfo) {
      continue;
    }

    const side = order.params.side === 0 ? "buy" : "sell";

    let value: string;
    if (side === "buy") {
      // For buy orders, we set the value as `price - fee` since it's
      // best for UX to show the user exactly what they're going to
      // receive on offer acceptance (and that is `price - fee` and
      // not `price`)
      const fee = order.params.takerRelayerFee;
      value = bn(order.params.basePrice)
        .sub(bn(order.params.basePrice).mul(bn(fee)).div(10000))
        .toString();
    } else {
      // For sell orders, the value is the same as the price
      value = order.params.basePrice;
    }

    // Handle fees

    const feeBps = Math.max(
      order.params.makerRelayerFee,
      order.params.takerRelayerFee
    );

    let sourceInfo;
    switch (order.params.feeRecipient) {
      // OpenSea
      case "0x5b3256965e7c3cf26e11fcaf296dfc8807c01073": {
        sourceInfo = {
          id: "opensea",
          bps: 250,
        };
        break;
      }

      // LootExchange
      case "0x8cfdf9e9f7ea8c0871025318407a6f1fbc5d5a18":
      case "0x8e71a0d2cc9c48173d9a9b7d90d6036093212afa": {
        sourceInfo = {
          id: "lootexchange",
          bps: 0,
        };
        break;
      }

      // Unknown
      default: {
        sourceInfo = {
          id: "unknown",
          // Assume everything goes to the order's fee recipient
          bps: feeBps,
        };
        break;
      }
    }

    // Handle royalties

    const royalty: { recipient: string } | null = await db.oneOrNone(
      `
        select
          "c"."royalty_recipient" as "recipient"
        from "collections" "c"
        join "tokens" "t"
          on "c"."id" = "t"."collection_id"
        where "t"."contract" = $/contract/
        limit 1
      `,
      { contract: order.params.target }
    );

    let royaltyInfo;
    if (royalty) {
      // Royalties are whatever is left after subtracting the marketplace fee
      const bps = feeBps - sourceInfo.bps;
      if (bps > 0) {
        royaltyInfo = [
          {
            recipient: royalty.recipient,
            bps: feeBps - sourceInfo.bps,
          },
        ];
      }
    }

    // TODO: Not at all critical, but multi-row inserts could
    // do here to get better insert performance when handling
    // multiple orders
    queries.push({
      query: `
        insert into "orders" (
          "hash",
          "kind",
          "status",
          "side",
          "token_set_id",
          "token_set_label_hash",
          "maker",
          "price",
          "value",
          "valid_between",
          "source_info",
          "royalty_info",
          "raw_data"
        ) values (
          $/hash/,
          $/kind/,
          $/status/,
          $/side/,
          $/tokenSetId/,
          $/tokenSetLabelHash/,
          $/maker/,
          $/price/,
          $/value/,
          tstzrange(to_timestamp($/listingTime/), to_timestamp($/expirationTime/)),
          $/sourceInfo:json/,
          $/royaltyInfo:json/,
          $/rawData/
        ) on conflict ("hash") do
        update set
          "side" = $/side/,
          "token_set_id" = $/tokenSetId/,
          "token_set_label_hash" = $/tokenSetLabelHash/,
          "maker" = $/maker/,
          "price" = $/price/,
          "value" = $/value/,
          "valid_between" = tstzrange(to_timestamp($/listingTime/), to_timestamp($/expirationTime/)),
          "source_info" = $/sourceInfo:json/,
          "royalty_info" = $/royaltyInfo:json/,
          "raw_data" = $/rawData/
      `,
      values: {
        hash: order.prefixHash(),
        kind: "wyvern-v2",
        status: "valid",
        side,
        tokenSetId: tokenSetInfo.id,
        tokenSetLabelHash: tokenSetInfo.labelHash,
        maker: order.params.maker,
        price: order.params.basePrice,
        value,
        listingTime: order.params.listingTime,
        expirationTime:
          order.params.expirationTime == 0
            ? "infinity"
            : order.params.expirationTime,
        sourceInfo,
        royaltyInfo,
        rawData: order.params,
      },
    });
  }

  if (queries.length) {
    await db.none(pgp.helpers.concat(queries));
  }
  await addToOrdersUpdateByHashQueue(
    orders.map((order) => ({ hash: order.prefixHash() }))
  );
};
