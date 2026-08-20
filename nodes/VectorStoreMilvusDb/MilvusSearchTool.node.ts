/*
 * Milvus Search Tool (Database)
 * n8n community node: exposes a database-scoped Milvus similarity search as a
 * tool for an AI Agent.
 *
 * Why this exists as a SEPARATE node from the vector store:
 * The vector-store node uses n8n's createVectorStoreNode, which requires the
 * @n8n/ai-utilities package to be resolvable at runtime. On multi-pod queue-mode
 * clusters that package is not always exposed to community nodes on every pod
 * (notably the webhook-processor), so a workflow using it can fail to build on
 * that pod. This tool deliberately imports NOTHING from @n8n/ai-utilities. It
 * builds the tool from @langchain/core (bundled) and searches Milvus via the
 * @zilliz SDK (bundled), and pulls the query embedding from the connected
 * embeddings sub-node by calling its methods directly. So it loads on every pod
 * with no init container and no peer-dependency resolution.
 */
import { DynamicTool } from '@langchain/core/tools';
import {
	NodeConnectionTypes,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

import { milvusCollectionRLC, milvusDatabaseRLC } from './descriptions';
import {
	createMilvusClient,
	milvusCollectionsSearch,
	milvusDatabasesSearch,
	type MilvusCredentials,
} from './listSearch';

// Minimal shape we rely on from the connected embeddings sub-node. We only call
// embedQuery — no instanceof — so it works regardless of which @langchain copy
// created the object.
interface EmbeddingsLike {
	embedQuery(text: string): Promise<number[]>;
}

export class MilvusSearchTool implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Milvus Search Tool (Database)',
		name: 'milvusSearchTool',
		icon: { light: 'file:milvusdb.svg', dark: 'file:milvusdb.svg' },
		group: ['transform'],
		version: 1,
		description: 'Database-scoped Milvus similarity search, exposed as a tool for an AI Agent',
		defaults: { name: 'Milvus Search Tool (Database)' },
		codex: {
			categories: ['AI'],
			subcategories: { AI: ['Tools'] },
			resources: { primaryDocumentation: [{ url: '' }] },
		},
		// Sub-node: consumes an embeddings model, outputs a tool for the agent.
		inputs: [
			{
				displayName: 'Embedding',
				type: NodeConnectionTypes.AiEmbedding,
				required: true,
				maxConnections: 1,
			},
		],
		outputs: [
			{
				displayName: 'Tool',
				type: NodeConnectionTypes.AiTool,
			},
		],
		credentials: [{ name: 'milvusApi', required: true }],
		properties: [
			{
				displayName: 'Tool Name',
				name: 'toolName',
				type: 'string',
				default: 'milvus_search',
				required: true,
				description:
					'Name the AI Agent uses to call this tool. Use letters, numbers, and underscores only.',
				placeholder: 'milvus_search',
			},
			{
				displayName: 'Tool Description',
				name: 'toolDescription',
				type: 'string',
				typeOptions: { rows: 3 },
				default:
					'Search the knowledge base for relevant information. Input should be a search query.',
				required: true,
				description: "Tells the agent when and how to use the tool. Be specific about what's inside.",
			},
			milvusDatabaseRLC,
			milvusCollectionRLC,
			{
				displayName: 'Limit',
				name: 'topK',
				type: 'number',
				default: 4,
				description: 'How many matching chunks to return per search',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Text Field',
						name: 'textField',
						type: 'string',
						default: 'langchain_text',
						description:
							'The collection field holding the chunk text. LangChain-created collections use langchain_text.',
					},
					{
						displayName: 'Vector Field',
						name: 'vectorField',
						type: 'string',
						default: 'langchain_vector',
						description:
							'The collection field holding the embedding vector. LangChain-created collections use langchain_vector.',
					},
					{
						displayName: 'Metric Type',
						name: 'metricType',
						type: 'options',
						default: 'L2',
						options: [
							{ name: 'L2', value: 'L2' },
							{ name: 'Cosine', value: 'COSINE' },
							{ name: 'Inner Product (IP)', value: 'IP' },
						],
						description: 'Must match the metric the collection index was built with',
					},
				],
			},
		],
	};

	methods = {
		listSearch: {
			// Reuse the same dropdown search helpers as the vector-store node.
			// These use only the @zilliz SDK — no @n8n/ai-utilities.
			milvusDatabasesSearch,
			milvusCollectionsSearch,
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = (await this.getCredentials('milvusApi')) as unknown as MilvusCredentials;

		const database =
			(this.getNodeParameter('milvusDatabase', itemIndex, 'default', {
				extractValue: true,
			}) as string) || 'default';
		const collection = this.getNodeParameter('milvusCollection', itemIndex, '', {
			extractValue: true,
		}) as string;
		const topK = this.getNodeParameter('topK', itemIndex, 4) as number;
		const toolName = this.getNodeParameter('toolName', itemIndex, 'milvus_search') as string;
		const toolDescription = this.getNodeParameter('toolDescription', itemIndex, '') as string;
		const options = this.getNodeParameter('options', itemIndex, {}) as {
			textField?: string;
			vectorField?: string;
			metricType?: string;
		};
		const textField = options.textField || 'langchain_text';
		const vectorField = options.vectorField || 'langchain_vector';
		const metricType = options.metricType || 'L2';

		// The connected embeddings sub-node (OpenAI/Qwen/etc). We only call
		// embedQuery on it — duck-typed, copy-agnostic.
		const embeddings = (await this.getInputConnectionData(
			NodeConnectionTypes.AiEmbedding,
			0,
		)) as EmbeddingsLike;

		const tool = new DynamicTool({
			name: toolName,
			description: toolDescription,
			func: async (query: string): Promise<string> => {
				const client = createMilvusClient(credentials, database);
				try {
					const vector = await embeddings.embedQuery(query);

					// Make sure the collection is queryable.
					try {
						await client.loadCollection({ collection_name: collection });
					} catch {
						// already loaded, or load not permitted for this user — ignore
					}

					const res = await client.search({
						collection_name: collection,
						data: [vector],
						limit: topK,
						output_fields: [textField],
						metric_type: metricType,
						anns_field: vectorField,
					});

					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const hits: any[] = (res && (res as any).results) || [];
					if (hits.length === 0) return 'No relevant results found.';

					return hits
						.map((h, i) => {
							const text = h?.[textField];
							const score = h?.score ?? h?.distance;
							const body = typeof text === 'string' ? text : JSON.stringify(h);
							return `[${i + 1}${score !== undefined ? ` | score ${score}` : ''}] ${body}`;
						})
						.join('\n\n');
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return `Milvus search failed: ${message}`;
				} finally {
					await client.closeConnection();
				}
			},
		});

		return { response: tool };
	}
}
