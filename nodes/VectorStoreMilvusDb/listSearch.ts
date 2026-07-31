import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';

export interface MilvusCredentials {
	baseUrl: string;
	username: string;
	password: string;
}

/**
 * Builds a raw SDK client. `database` is applied at connection time, which is what
 * scopes every subsequent call (listCollections, describeCollection, ...) to that db.
 */
export function createMilvusClient(credentials: MilvusCredentials, database?: string) {
	return new MilvusClient({
		address: credentials.baseUrl,
		token: `${credentials.username}:${credentials.password}`,
		...(database ? { database } : {}),
	});
}

/**
 * Populates the Database dropdown.
 *
 * Note: in ILoadOptionsFunctions the signature is getNodeParameter(name, fallback, options)
 * — there is no itemIndex argument here, unlike IExecuteFunctions.
 */
export async function milvusDatabasesSearch(
	this: ILoadOptionsFunctions,
): Promise<INodeListSearchResult> {
	const credentials = (await this.getCredentials('milvusApi')) as unknown as MilvusCredentials;
	const client = createMilvusClient(credentials);

	try {
		const response = await client.listDatabases();
		const names = response.db_names ?? [];

		// Guarantee `default` is always offered, even on clusters where the
		// credential user cannot enumerate databases.
		const unique = Array.from(new Set(['default', ...names]));

		return { results: unique.map((name) => ({ name, value: name })) };
	} catch {
		// Milvus < 2.2, or a user without database-level privileges.
		return { results: [{ name: 'default', value: 'default' }] };
	} finally {
		await client.closeConnection();
	}
}

/**
 * Populates the Collection dropdown, scoped to the currently selected database.
 */
export async function milvusCollectionsSearch(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const credentials = (await this.getCredentials('milvusApi')) as unknown as MilvusCredentials;

	const database = this.getNodeParameter('milvusDatabase', 'default', {
		extractValue: true,
	}) as string;

	const client = createMilvusClient(credentials, database || 'default');

	try {
		const response = await client.listCollections();
		let results = (response.data ?? []).map((collection) => ({
			name: collection.name,
			value: collection.name,
		}));

		if (filter) {
			const needle = filter.toLowerCase();
			results = results.filter((r) => r.name.toLowerCase().includes(needle));
		}

		return { results };
	} finally {
		await client.closeConnection();
	}
}
