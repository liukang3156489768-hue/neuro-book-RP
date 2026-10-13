import type {MaterialReviewActionDto} from "nbook/shared/dto/inspiration-extraction-api.dto";
import type {ExtractionServices} from "./host";
import type {MaterialReview} from "./material-review";

/**
 * 把界面的一次审阅操作分派给 `MaterialReviewService`。
 * 请求形状由 DTO 约束；节点的字段归属、模板、引用等语义由审阅服务校验并以 `MaterialReviewError` 拒绝，
 * 所以这里不重复校验。只有手动合并会调用模型，需要项目生命周期信号。
 */
export function applyMaterialReviewAction(services: ExtractionServices, taskId: string, action: MaterialReviewActionDto): Promise<MaterialReview> {
    const {review} = services;
    switch (action.kind) {
        case "select": return review.setSelected(taskId, action.itemIds, action.selected);
        case "update": return review.update(taskId, action.itemId, {
            ...(action.patch.title === undefined ? {} : {title: action.patch.title}),
            ...(action.patch.aliases === undefined ? {} : {aliases: action.patch.aliases}),
            ...(action.patch.nodes === undefined ? {} : {nodes: action.patch.nodes}),
        });
        case "remove": return review.remove(taskId, action.itemId);
        case "split": return review.split(taskId, action.itemId, action.input);
        case "merge": return services.withSignal(signal => review.merge(taskId, action.itemIds, signal));
    }
}
