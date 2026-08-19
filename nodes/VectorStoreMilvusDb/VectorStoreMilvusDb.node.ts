/*
 * Milvus Vector Store (Database)
 * n8n community node: Milvus vector store with explicit database selection.
 */
import { Milvus } from '@langchain/community/vectorstores/milvus';
import { createVectorStoreNode } from '@n8n/ai-utilities';
import type { Embeddings } from '@langchain/core/embeddings';
import type { Document } from '@langchain/core/documents';
import {
	NodeConnectionTypes,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeProperties,
	type ISupplyDataFunctions,
} from 'n8n-workflow';

import { milvusCollectionRLC, milvusDatabaseRLC } from './descriptions';
import {
	createMilvusClient,
	milvusCollectionsSearch,
	milvusDatabasesSearch,
	type MilvusCredentials,
} from './listSearch';

const sharedFields: INodeProperties[] = [milvusDatabaseRLC, milvusCollectionRLC];

const insertFields: INodeProperties[] = [
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		options: [
			{
				displayName: 'Clear Collection',
				name: 'clearCollection',
				type: 'boolean',
				default: false,
				description: 'Whether to drop the collection before inserting new data',
			},
		],
	},
];

type Context = IExecuteFunctions | ISupplyDataFunctions;

/**
 * Resolves credential + database + collection into the args LangChain's Milvus wants.
 *
 * The Milvus constructor spreads `clientConfig` first and then overrides
 * address/username/password from the top-level fields, so `database` set inside
 * clientConfig survives and is what pins the connection to the right db.
 */
async function resolveConfig(context: Context, itemIndex: number) {
	const credentials = (await context.getCredentials('milvusApi')) as unknown as MilvusCredentials;

	const database =
		(context.getNodeParameter('milvusDatabase', itemIndex, 'default', {
			extractValue: true,
		}) as string) || 'default';

	const collection = context.getNodeParameter('milvusCollection', itemIndex, '', {
		extractValue: true,
	}) as string;

	return {
		credentials,
		database,
		collection,
		config: {
			url: credentials.baseUrl,
			username: credentials.username,
			password: credentials.password,
			collectionName: collection,
			clientConfig: {
				address: credentials.baseUrl,
				username: credentials.username,
				password: credentials.password,
				database,
			},
		},
	};
}

/**
 * Drops the collection first when the user ticked "Clear Collection", then writes
 * the documents into the selected database + collection via LangChain's Milvus.
 */
async function insertDocuments(
	context: Context,
	embeddings: Embeddings,
	documents: Array<Document<Record<string, unknown>>>,
	itemIndex: number,
	alreadyCleared: boolean,
): Promise<boolean> {
	const { credentials, database, collection, config } = await resolveConfig(context, itemIndex);

	let didClear = alreadyCleared;
	const options = context.getNodeParameter('options', itemIndex, {}) as {
		clearCollection?: boolean;
	};
	if (options.clearCollection && !alreadyCleared) {
		const client = createMilvusClient(credentials, database);
		try {
			await client.dropCollection({ collection_name: collection });
		} finally {
			await client.closeConnection();
		}
		didClear = true;
	}

	if (documents.length > 0) {
		await Milvus.fromDocuments(documents, embeddings, config);
	}
	return didClear;
}

/**
 * Base node from n8n's shared vector-store factory. This gives us load / retrieve /
 * retrieve-as-tool for free; we override the INSERT path below.
 */
const BaseNode = createVectorStoreNode<Milvus>({
	meta: {
		displayName: 'Milvus Vector Store (Database)',
		name: 'vectorStoreMilvusDb',
		description: 'Work with your data in Milvus, with explicit database selection',
		icon: { light: 'file:milvusdb.svg', dark: 'file:milvusdb.svg' },
		docsUrl:
			'https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.vectorstoremilvus/',
		credentials: [
			{
				name: 'milvusApi',
				required: true,
			},
		],
		operationModes: ['load', 'insert', 'retrieve', 'retrieve-as-tool'],
	},
	methods: {
		listSearch: {
			milvusDatabasesSearch,
			milvusCollectionsSearch,
		},
	},
	sharedFields,
	insertFields,

	async getVectorStoreClient(context, _filter, embeddings: Embeddings, itemIndex: number) {
		const { config } = await resolveConfig(context, itemIndex);
		return await Milvus.fromExistingCollection(embeddings, config);
	},

	// Retained for completeness; the insert path is handled by our own execute()
	// override below, which does not route through n8n's processDocuments().
	async populateVectorStore(context, embeddings: Embeddings, documents, itemIndex: number) {
		await insertDocuments(context, embeddings, documents, itemIndex, false);
	},
});

/**
 * Duck-types the Document Loader supplied on the AiDocument input.
 *
 * n8n's own insert path checks `documentInput instanceof N8nJsonLoader` — but a
 * community node resolves a different copy of @n8n/ai-utilities than the one that
 * created the loader, so that instanceof is false and n8n then calls `.map` on a
 * loader object → "processedDocuments.map is not a function". We avoid instanceof
 * entirely and just call the loader's own methods if they exist.
 */
async function extractDocuments(
	context: IExecuteFunctions,
	documentInput: unknown,
	items: INodeExecutionData[],
): Promise<Array<Document<Record<string, unknown>>>> {
	const loader = documentInput as {
		processAll?: (items: INodeExecutionData[]) => Promise<Array<Document<Record<string, unknown>>>>;
		processItem?: (
			item: INodeExecutionData,
			index: number,
		) => Promise<Array<Document<Record<string, unknown>>>>;
	};

	if (loader && typeof loader.processAll === 'function') {
		return await loader.processAll(items);
	}

	if (loader && typeof loader.processItem === 'function') {
		const out: Array<Document<Record<string, unknown>>> = [];
		for (let i = 0; i < items.length; i++) {
			const part = await loader.processItem(items[i], i);
			if (Array.isArray(part)) out.push(...part);
			else if (part) out.push(part as unknown as Document<Record<string, unknown>>);
		}
		return out;
	}

	if (Array.isArray(documentInput)) {
		return documentInput as Array<Document<Record<string, unknown>>>;
	}

	return [];
}

export class VectorStoreMilvusDb extends BaseNode {
	constructor() {
		super();
		// n8n's community-node installer stores a node's version in an INTEGER
		// database column; the vector-store base assigns a fractional version
		// ([1, 1.1, 1.2, 1.3]) which fails to install on PostgreSQL
		// ("invalid input syntax for type integer: 1.3", n8n issue #23456).
		// A single integer keeps installs working; 2 preserves the field
		// visibility of the 1.3 behaviour (Embedding Batch Size shown, legacy
		// tool-name field hidden).
		this.description.version = 2;
	}

	// Override execute so INSERT does its own document handling (duck-typed),
	// bypassing n8n's processDocuments() instanceof check that crashes for a
	// community node. Every other mode is delegated to the base implementation.
	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const mode = this.getNodeParameter('mode', 0) as string;

		if (mode !== 'insert') {
			return await (BaseNode.prototype.execute as (this: IExecuteFunctions) => Promise<
				INodeExecutionData[][]
			>).call(this);
		}

		const embeddings = (await this.getInputConnectionData(
			NodeConnectionTypes.AiEmbedding,
			0,
		)) as Embeddings;

		const items = this.getInputData();
		const documentInput = await this.getInputConnectionData(NodeConnectionTypes.AiDocument, 0);

		const documents = await extractDocuments(this, documentInput, items);

		const embeddingBatchSize =
			(this.getNodeParameter('embeddingBatchSize', 0, 200) as number) ?? 200;

		let cleared = false;
		for (let i = 0; i < documents.length; i += embeddingBatchSize) {
			const batch = documents.slice(i, i + embeddingBatchSize);
			cleared = await insertDocuments(this, embeddings, batch, 0, cleared);
		}

		// If clearing was requested but there were no documents, still honour it.
		if (documents.length === 0) {
			cleared = await insertDocuments(this, embeddings, [], 0, cleared);
		}

		const serialized: INodeExecutionData[] = documents.map((doc) => ({
			json: {
				metadata: (doc.metadata ?? {}) as IDataObject,
				pageContent: doc.pageContent,
			} as IDataObject,
		}));

		return [serialized];
	}
}
