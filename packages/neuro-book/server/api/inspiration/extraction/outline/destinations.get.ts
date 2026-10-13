import {defineEventHandler, getQuery} from "h3";
import {OutlineDestinationQuerySchema} from "nbook/shared/dto/inspiration-extraction-api.dto";
import {parseExtractionRequest, withExtractionServices} from "nbook/server/inspiration/extraction/http";

/** 该来源已有提取方案，可作为“覆盖/追加”去向的选项；来源哈希由服务端读盘得出，客户端不能指定。 */
export default defineEventHandler(async (event) => {
    const query = parseExtractionRequest(OutlineDestinationQuerySchema, getQuery(event), "数据去向查询");
    return withExtractionServices(query.projectRoot, services => services.destinations(query.path));
});
